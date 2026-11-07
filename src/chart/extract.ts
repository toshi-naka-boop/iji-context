// カルテの文章から、算定に要る事実を取り出す（spec FR-69。2026-11-07 ユーザー判断で B 案）
// 取り出すのは AI。ただし事実ごとに「カルテのどの言葉から取ったか」（quote）を付けさせ、カルテに実際にない言葉の事実は捨てる。
// 取り出した結果は本人が確かめて直してから使う。判定はユスティだけが行う（AI は判定しない）
import { modelOptions, type ModelChoice } from "../mentor/models";
import { runOnce } from "../mentor/run";

/** 本人が書くカルテ（1 回の訪問） */
export type ChartNote = { s: string; o: string; a: string; p: string; rx: string };

/** 取り出す事実。処方は分類名（DOAC など）、病名はカルテに書かれた名前、急性増悪は書かれているときだけ */
export type ExtractedFact =
  | { kind: "処方"; value: string; quote: string }
  | { kind: "病名の記載"; value: string; quote: string }
  | { kind: "急性増悪"; value: string; quote: string };

export const FACT_KINDS = ["処方", "病名の記載", "急性増悪"] as const;

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: [...FACT_KINDS] }, value: { type: "string" }, quote: { type: "string" } },
        required: ["kind", "value", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

export const EXTRACT_PROMPT = [
  "あなたは在宅医療のカルテから、医療事務が算定に使う事実を取り出します。判定や助言はしない。",
  "取り出すのは次の 3 種類だけ：",
  "- 処方：処方されている薬の分類名（例：DOAC、利尿薬、インスリン）。薬の名前で書かれていても分類名で value に入れる",
  "- 病名の記載：A（評価）などに書かれた病名や略語。value は書かれたとおり（略語を言い換えない）",
  "- 急性増悪：急性増悪・急変と書かれているときだけ。value は「あり」",
  "どの事実にも quote を付ける。quote はカルテに書かれた文字をそのまま写した短い部分（言い換え・要約をしない）。",
  "書かれていないことは出さない。推測で病名・病型・処方を足さない。何もなければ facts は空にする。",
].join("\n");

/** カルテを 1 つの文章にする（AI に渡す形） */
export function noteText(n: ChartNote): string {
  return [`S: ${n.s}`, `O: ${n.o}`, `A: ${n.a}`, `P: ${n.p}`, `処方: ${n.rx}`].join("\n");
}

const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * 取り出した結果を検査する（決まった規則）。
 * 形の違うもの、種類が範囲外のもの、quote がカルテにないもの（作り足しの疑い）は捨て、捨てた理由を返す
 */
export function validateFacts(raw: unknown, note: ChartNote): { facts: ExtractedFact[]; dropped: { fact: unknown; why: string }[] } {
  const text = squash(noteText(note));
  const list = (raw as { facts?: unknown } | null)?.facts;
  const facts: ExtractedFact[] = [];
  const dropped: { fact: unknown; why: string }[] = [];
  if (!Array.isArray(list)) return { facts, dropped: [{ fact: raw, why: "形が違う" }] };
  for (const f of list) {
    const o = f as Partial<ExtractedFact> | null;
    if (!o || typeof o.value !== "string" || typeof o.quote !== "string" || !o.value.trim() || !o.quote.trim()) dropped.push({ fact: f, why: "形が違う" });
    else if (!(FACT_KINDS as readonly string[]).includes(o.kind as string)) dropped.push({ fact: f, why: "取り出す種類の外" });
    else if (!text.includes(squash(o.quote))) dropped.push({ fact: f, why: "カルテにない言葉から取っている" });
    else facts.push({ kind: o.kind as ExtractedFact["kind"], value: o.value.trim(), quote: o.quote.trim() });
  }
  return { facts, dropped };
}

/** カルテから事実を取り出す（LLM）。出力は validateFacts を通してから返す */
export async function extractFacts(note: ChartNote, model?: ModelChoice) {
  const r = await runOnce("chartExtract", noteText(note), {
    systemPrompt: EXTRACT_PROMPT,
    tools: [],
    settingSources: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: EXTRACT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 2,
    ...modelOptions(model),
  });
  return validateFacts(r.structured, note);
}
