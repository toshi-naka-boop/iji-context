// メンターの出力の型と検査（spec FR-11・FR-21〜24）。LLM の出力はここを通してから画面に出す
import type { EngineResult } from "../engine/types";
export const EXPRESSIONS = ["通常", "笑顔", "考え中", "驚き", "困り", "称賛"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type MentorOutput = {
  /** 本文（ヒント・理由・解説） */
  body: string;
  expression: Expression;
  /** 引用した知識の id（F5 に USED として渡す） */
  citedKnowledge: string[];
};

/** Agent SDK の outputFormat（json_schema）に渡すスキーマ */
export const MENTOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string" },
    expression: { type: "string", enum: [...EXPRESSIONS] },
    citedKnowledge: { type: "array", items: { type: "string" } },
  },
  required: ["body", "expression", "citedKnowledge"],
  additionalProperties: false,
} as const;

/** 今の場面。表情の制約に使う */
export type Situation =
  | "新人の誤り" // 確定した請求に指摘がある
  | "カルテ不足" // 医師側の記載が足りない
  | "審査が難しい"
  | "正方向" // 知識が増えた／承認された／連続正解／月次完了（FR-24）
  | "通常";

/**
 * 表情の制約：「困り」はカルテ不足と審査が難しい場面だけ（新人の誤りには出さない。FR-23）。
 * 喜ぶ表情（笑顔・称賛）は正方向の出来事だけ（FR-24）。外れたら「考え中」か「通常」に置き換える
 */
export function guardExpression(e: Expression, s: Situation): Expression {
  if (e === "困り" && s !== "カルテ不足" && s !== "審査が難しい") return "考え中";
  if ((e === "笑顔" || e === "称賛") && s !== "正方向") return "通常";
  return e;
}

/** LLM の出力を検査する。形が違えば例外（画面に出さない） */
export function parseMentorOutput(raw: unknown, s: Situation): MentorOutput {
  const o = raw as Partial<MentorOutput> | null;
  if (!o || typeof o !== "object") throw new Error("メンターの出力がオブジェクトでない");
  if (typeof o.body !== "string" || o.body.trim() === "") throw new Error("本文がない");
  if (!EXPRESSIONS.includes(o.expression as Expression)) throw new Error(`表情が不正: ${String(o.expression)}`);
  if (!Array.isArray(o.citedKnowledge) || o.citedKnowledge.some((x) => typeof x !== "string")) throw new Error("引用した知識の id が不正");
  return { body: o.body, expression: guardExpression(o.expression as Expression, s), citedKnowledge: [...new Set(o.citedKnowledge)] };
}

/** 言い直させても答えに触れていたときの決まった文 */
export const ANSWER_FALLBACK = "明細の各行と、算定の条件をもう一度見比べてみてください。気になる行があれば、その行について聞いてください。";

/**
 * ヒントの段階で、本文が答えに触れていないかを決まった規則で調べる。触れていた語を返す（空なら問題なし）。
 * 見るもの：指摘の根拠（区分の名前）、指摘の種類（取り忘れ・背反など）、点数の数字。情報不足は本人の誤りではないので対象外。
 * 取り忘れでは、足すべき項目の名前（根拠のうち「〜加算」「〜料」）がそのまま答えになるので、それも見る
 */
export function leakedTerms(body: string, engine: EngineResult): string[] {
  const out = new Set<string>();
  for (const f of engine.findings) {
    if (f.kind === "情報不足") continue;
    if (body.includes(f.reference)) out.add(f.reference);
    if (body.includes(f.kind)) out.add(f.kind);
    if (f.kind === "取り忘れ") {
      for (const t of f.reference.split(/[\s・、（）()]+/)) if (t.length >= 4 && /(加算|料)$/.test(t) && body.includes(t)) out.add(t);
    }
  }
  const pts = body.match(/[0-9０-９][0-9０-９,，]*\s*点/);
  if (pts) out.add(pts[0]);
  return [...out];
}
