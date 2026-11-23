// 査定・返戻の通知（PDF）の読み取り（spec FR-42・FR-43、EM 5-1 K6）。
// Claude は PDF から書かれていることを取り出すだけ。区分・請求・審査支払機関への対応づけは、ここで決まった規則で行う。
// 知識の候補にするのは、本人が画面で確かめてボタンを押したときだけ。状態（未検証／contested）は F5 の規則が決める
import { createHash } from "node:crypto";
import { hasRevision, resolveRevision } from "../engine/revisions";
import type { CreateInput } from "../lifecycle/store";
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce, type RunStats, type SDKUserMessage, type Sender } from "../llm/outbound";
import { badRequest } from "../server/errors";
import { payerOfInsurer } from "../uke/cases";
import { CHOOSABLE, ITEM_MANY, ITEM_NOT_FOUND, itemOutside, PATIENT_MANY, PATIENT_NOT_FOUND } from "./problems";

export { CHOOSABLE, ITEM_MANY, ITEM_NOT_FOUND, itemOutside, PATIENT_MANY, PATIENT_NOT_FOUND };

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
export async function readNotice(by: Sender, pdf: Buffer, model?: ModelChoice): Promise<{ notice: Notice; stats: RunStats }> {
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
  const r = await runOnce(by, "notice", prompt(), {
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
  /**
   * 項目名から区分が 1 つに決まらなかったとき（見つからない・複数ある）に、本人が選べる区分。選べないときは空。
   * 同じ月の請求があればその請求にある区分、なければ項目の診療年月の版の区分すべて（複数あるときは、当たった区分だけ）
   */
  choices: { kubun: string; name: string }[];
};

/** 通知と照らす請求 1 件（取り込んだ UKE のレセプト。src/server/app/knowledge.ts が作る） */
export type NoticeClaim = { claimId: string; yearMonth: string; prefecture: string; patientName: string; insurerNumber: string; kubuns: string[] };

/**
 * 項目名を基本マスターの名称で引く（マスターがあるときだけ渡す）。kubuns は、版の区分のコードの名称が項目名と一致した区分。
 * outside は、版の区分の表にないコードで名称が一致したもの（知識は区分でしか条件を持てないので、候補にしない）
 */
export type MasterNames = (yearMonth: string, itemName: string) => { kubuns: string[]; outside: string[] };

/** 名称の比べ方：全角・半角をそろえ（NFKC）、空白を除く。それ以上のあいまいな一致はしない */
export const normName = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

/**
 * 取り出した項目を、患者・区分・審査支払機関に対応づける（決まった規則）。
 * 患者は、取り込んだ請求の氏名と保険者番号で引く。通知は前の月までの請求について来るので、月はまたいで引き、同じ月の請求があればそれを採る（なければいちばん新しい月）。
 * 区分は、項目の診療年月の版の区分の名称と、基本マスターの名称（names）の完全一致で引く（design.md §2-4）。審査支払機関は保険者番号から決める
 */
export function resolveNotice(notice: Notice, claims: NoticeClaim[], names?: MasterNames): ResolvedItem[] {
  return notice.items.map((i) => {
    const problems: string[] = [];
    const hits = claims.filter((c) => normName(c.patientName) === normName(i.patientName) && c.insurerNumber === i.insurerNumber.trim());
    const same = hits.filter((c) => c.yearMonth === i.yearMonth);
    const claim = same.length === 1 ? same[0] : same.length === 0 ? [...hits].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))[0] : undefined;
    if (hits.length === 0) problems.push(PATIENT_NOT_FOUND);
    else if (!claim) problems.push(PATIENT_MANY);
    const claimId = claim?.claimId ?? null;
    let kubun: string | null = null;
    let choices: ResolvedItem["choices"] = [];
    if (!hasRevision(i.yearMonth)) {
      problems.push("診療年月に当たる版がない");
    } else {
      const points = resolveRevision(i.yearMonth).points;
      const want = normName(i.itemName);
      const master = names?.(i.yearMonth, i.itemName) ?? { kubuns: [], outside: [] };
      const kubuns = [...new Set([...Object.entries(points).filter(([, d]) => normName(d.name) === want).map(([k]) => k), ...master.kubuns])];
      kubun = kubuns.length === 1 ? kubuns[0] : null;
      const named = (ks: string[]) => ks.map((k) => ({ kubun: k, name: points[k].name }));
      if (kubuns.length > 1) {
        problems.push(ITEM_MANY);
        choices = named(kubuns);
      } else if (kubuns.length === 0 && master.outside.length > 0) {
        problems.push(itemOutside(master.outside));
      } else if (kubuns.length === 0) {
        problems.push(ITEM_NOT_FOUND);
        choices = named(claim && claim.yearMonth === i.yearMonth ? [...new Set(claim.kubuns)].filter((k) => k in points) : Object.keys(points));
      }
    }
    let payer: ResolvedItem["payer"] = null;
    try {
      payer = payerOfInsurer(i.insurerNumber.trim());
    } catch {
      problems.push("保険者番号の形式が違う");
    }
    const prefecture = claim?.prefecture ?? null;
    if (prefecture && notice.prefecture && prefecture !== notice.prefecture) problems.push(`通知の都道府県（${notice.prefecture}）と請求（${prefecture}）が違う`);
    return { ...i, claimId, kubun, payer, prefecture, problems, choices };
  });
}

/**
 * 本人が選んだ区分で、項目の対応づけを済ませる。選べるのは choices にある区分だけで、消えるのは区分の問題だけ（ほかの問題は残る）
 */
export function chooseKubun(item: ResolvedItem, kubun: string): ResolvedItem {
  if (!item.choices.some((c) => c.kubun === kubun)) throw badRequest("その区分は、この項目では選べません");
  return { ...item, kubun, problems: item.problems.filter((p) => !CHOOSABLE.includes(p)) };
}

/** 条件の注記に写す、通知の理由の長さの上限（設計パラメータ） */
export const REASON_NOTE_MAX = 200;

/** 通知の理由から、条件の注記を決まった規則で作る。理由の有無で変わるのは注記の文だけ */
export function conditionNoteOf(reason: string): string {
  const r = reason.replace(/[\s　]+/g, " ").trim();
  return r.length > 0 ? `通知の理由：${r.slice(0, REASON_NOTE_MAX)}` : "通知に理由の記載がない（条件は未確認）";
}

/**
 * 本人が確かめた 1 項目を、地域層の知識の候補にする入力（査定は必ず知識化。再審査を申し出るなら contested。FR-43）。
 * 候補は必ず avoid・近似にする：通知が言うのは「この請求のこの項目が落ちた」ことで、区分・審査支払機関・都道府県の 3 つが
 * 条件を表しきれているかは通知からは決められない。機械は連月・摘要コメントなどの条件を足さない（design.md §3）
 */
export function candidateOf(item: ResolvedItem, opts: { reexamFiled: boolean; fileName: string }): CreateInput {
  if (item.problems.length > 0 || !item.kubun || !item.payer || !item.prefecture) throw badRequest(`対応づけが済んでいない項目は候補にできない: ${item.problems.join(" / ")}`);
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
      "当てはまる条件は、区分・審査支払機関・都道府県だけでは表しきれていない（近似）。通知の理由を条件の注記として添える。",
    ].join("\n"),
    source: { type: item.outcome, ref },
    reexamFiled: item.outcome === "査定" && opts.reexamFiled,
    polarity: "avoid",
    matchApprox: true,
    conditionNote: conditionNoteOf(item.reason),
    match: { kubunAll: [item.kubun], payer: item.payer, prefecture: item.prefecture },
  };
}
