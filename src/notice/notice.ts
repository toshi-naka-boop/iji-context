// 査定・返戻の通知（PDF）の読み取り（spec FR-42・FR-43、EM 5-1 K6）。
// Claude は PDF から書かれていることを取り出すだけ。区分・請求・審査支払機関への対応づけは、ここで決まった規則で行う。
// 知識の候補にするのは、本人が画面で確かめてボタンを押したときだけ。状態（未検証／contested）は F5 の規則が決める
import { createHash } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { POINTS } from "../engine/points-2024";
import type { ClaimContext } from "../engine/types";
import type { CreateInput } from "../lifecycle/store";
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce, type RunStats } from "../mentor/run";
import { payerOfInsurer, type UkeSources } from "../uke/cases";

export const NOTICE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    documentType: { type: "string" },
    prefecture: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          yearMonth: { type: "string", description: "診療年月を西暦 YYYY-MM で" },
          patientName: { type: "string" },
          insurerNumber: { type: "string" },
          itemName: { type: "string" },
          outcome: { type: "string", enum: ["査定", "返戻"] },
          reason: { type: "string" },
        },
        required: ["yearMonth", "patientName", "insurerNumber", "itemName", "outcome", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["documentType", "prefecture", "items"],
  additionalProperties: false,
} as const;

export type NoticeItem = { yearMonth: string; patientName: string; insurerNumber: string; itemName: string; outcome: "査定" | "返戻"; reason: string };
export type Notice = { documentType: string; prefecture: string; items: NoticeItem[] };

export const NOTICE_PROMPT = [
  "あなたは医療事務の手伝いです。渡された査定・返戻の通知（PDF）から、書かれていることだけを取り出してください。",
  "書かれていない項目を推測で埋めない。読めない欄は空文字にする。和暦の診療年月は西暦の YYYY-MM に直す。",
  "点数・金額は取り出さない。",
].join("\n");

export function parseNotice(raw: unknown): Notice {
  const o = raw as Partial<Notice> | null;
  if (!o || typeof o.documentType !== "string" || typeof o.prefecture !== "string" || !Array.isArray(o.items)) throw new Error("通知の読み取り結果の形が違う");
  const items = o.items.filter(
    (i): i is NoticeItem =>
      !!i && /^\d{4}-\d{2}$/.test(i.yearMonth) && typeof i.patientName === "string" && typeof i.insurerNumber === "string" && typeof i.itemName === "string" && (i.outcome === "査定" || i.outcome === "返戻") && typeof i.reason === "string",
  );
  return { documentType: o.documentType, prefecture: o.prefecture, items };
}

/** PDF を Claude に読ませる（ドキュメントとして渡す。ファイル操作のツールは渡さない） */
export async function readNotice(pdf: Buffer, model?: ModelChoice): Promise<{ notice: Notice; stats: RunStats }> {
  async function* prompt(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: "この通知の項目を取り出してください。" },
        ],
      },
    } as SDKUserMessage;
  }
  const r = await runOnce("notice", prompt(), {
    systemPrompt: NOTICE_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: NOTICE_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 3,
    ...modelOptions(model),
  });
  return { notice: parseNotice(r.structured), stats: r.stats };
}

export type ResolvedItem = NoticeItem & {
  /** 決まった規則で対応づけた結果。null は対応が見つからない（本人が確かめる） */
  claimId: string | null;
  kubun: string | null;
  payer: "支払基金" | "国保連" | null;
  prefecture: string | null;
  problems: string[];
};

/** 取り出した項目を、患者（氏名と保険者番号）・区分（名称の完全一致）・審査支払機関（保険者番号）に対応づける */
export function resolveNotice(notice: Notice, src: UkeSources, cases: ClaimContext[]): ResolvedItem[] {
  const norm = (s: string) => s.replace(/[\s　]/g, "");
  return notice.items.map((i) => {
    const problems: string[] = [];
    const hit = Object.entries(src.patients).find(([, p]) => norm(p.name) === norm(i.patientName) && p.insurer.number === i.insurerNumber.trim());
    const claimId = hit?.[0] ?? null;
    if (!claimId) problems.push("患者（氏名と保険者番号）が見つからない");
    const kubuns = Object.entries(POINTS).filter(([, d]) => d.name === i.itemName.trim()).map(([k]) => k);
    const kubun = kubuns.length === 1 ? kubuns[0] : null;
    if (!kubun) problems.push(kubuns.length > 1 ? "項目名に当たる区分が複数ある" : "項目名に当たる区分が見つからない");
    let payer: ResolvedItem["payer"] = null;
    try {
      payer = payerOfInsurer(i.insurerNumber.trim());
    } catch {
      problems.push("保険者番号の形式が違う");
    }
    const prefecture = cases.find((c) => c.claimId === claimId)?.prefecture ?? null;
    if (prefecture && notice.prefecture && prefecture !== notice.prefecture) problems.push(`通知の都道府県（${notice.prefecture}）と請求（${prefecture}）が違う`);
    return { ...i, claimId, kubun, payer, prefecture, problems };
  });
}

/** 本人が確かめた 1 項目を、地域層の知識の候補にする入力（査定は必ず知識化。再審査を申し出るなら contested。FR-43） */
export function candidateOf(item: ResolvedItem, opts: { reexamFiled: boolean; fileName: string }): CreateInput {
  if (item.problems.length > 0 || !item.kubun || !item.payer || !item.prefecture) throw new Error(`対応づけが済んでいない項目は候補にできない: ${item.problems.join(" / ")}`);
  const ref = `${item.outcome}:${item.claimId}:${item.yearMonth}:${item.kubun}`;
  return {
    layer: "地域",
    slug: `notice-${createHash("sha256").update(ref).digest("hex").slice(0, 10)}`,
    summary: `${item.prefecture}・${item.payer}：${item.itemName}（${item.kubun}）が${item.outcome}された（${item.yearMonth} 診療分）`,
    body: [
      `# ${item.itemName} の${item.outcome}`,
      "",
      `${item.prefecture}の${item.payer}で、${item.yearMonth} 診療分の ${item.itemName}（${item.kubun}）が${item.outcome}された。`,
      "",
      `通知に書かれた理由：${item.reason}`,
      "",
      `出典：${opts.fileName}（読み取りは Claude、対応づけは決まった規則、登録は本人が確かめてから）`,
      "条件（コメントの有無・続けて算定した月数など）は、責任者がレセメン会議で確かめて書き足す。",
    ].join("\n"),
    source: { type: item.outcome, ref },
    reexamFiled: item.outcome === "査定" && opts.reexamFiled,
    match: { kubunAll: [item.kubun], payer: item.payer, prefecture: item.prefecture },
  };
}
