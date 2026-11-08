// F3 代行入力の整文（spec FR-36・FR-37、EM #13-1）：医療事務が代行入力する文章を整える。
// 足りない項目は推定せず ask_missing で聞く。整えた文は必ず医師確認（承認）を挟んでから記録になる（医政発第1228001号）
import type { QueryDraft } from "../query/doctor-query";
import { modelOptions, type ModelChoice } from "./models";
import { runOnce } from "./run";

export const SCRIBE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    missing: {
      type: "array",
      items: {
        type: "object",
        properties: { field: { type: "string" }, why: { type: "string" }, target: { type: "string", enum: ["doctor", "clerk"] } },
        required: ["field", "why", "target"],
        additionalProperties: false,
      },
    },
  },
  required: ["text", "missing"],
  additionalProperties: false,
} as const;

export type ScribeResult = { text: string; missing: { field: string; why: string; target: "doctor" | "clerk" }[] };

export const SCRIBE_PROMPT = [
  "あなたは医療事務の代行入力を手伝います。渡された下書きを、意味を変えずに読みやすい診療録の文に整えてください。",
  "書かれていないこと（病名・病型・検査値・施行事実・日付）を足したり推測したりしない。足りない項目は missing に入れる（臨床の内容は doctor、事務の内容は clerk）。",
  "点数・金額・請求の話を入れない。本文はプレーンテキストで書く。",
].join("\n");

export function parseScribe(raw: unknown): ScribeResult {
  const o = raw as Partial<ScribeResult> | null;
  if (!o || typeof o.text !== "string" || !Array.isArray(o.missing)) throw new Error("整文の出力の形が違う");
  return {
    text: o.text,
    missing: o.missing.filter((m): m is ScribeResult["missing"][number] => !!m && typeof m.field === "string" && typeof m.why === "string" && (m.target === "doctor" || m.target === "clerk")),
  };
}

/** 下書きを整える（LLM）。出力は検査してから使う */
export async function tidy(draftText: string, model?: ModelChoice): Promise<ScribeResult> {
  const r = await runOnce("scribe", draftText, {
    systemPrompt: SCRIBE_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: SCRIBE_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 2,
    ...modelOptions(model),
  });
  return parseScribe(r.structured);
}

/** 代行入力の医師確認（FR-37）。整えた文を医師に見せ、承認で記録になる。質問は 7 要件の検証を通る形 */
export function proxyConfirmDraft(claimId: string, original: string, tidied: string): QueryDraft {
  return {
    claimId,
    field: "代行入力",
    why: "医療事務が代行入力した内容を、医師が確認して確定する",
    question: "代行入力した内容が、診療の内容と合っているか確認してください。",
    indicators: [
      { source: "代行入力（整えた文）", text: tidied },
      { source: "代行入力（元の下書き）", text: original },
    ],
    options: ["この内容で確定する", "修正が必要", "その他", "判定不能"],
    createdBy: "clerk",
  };
}
