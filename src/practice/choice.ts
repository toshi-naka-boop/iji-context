// 選択モード（急いでいるとき）：区分を選ぶ箇所ごとに、正解 1 つと間違えやすい区分を並べる
// 選択肢は config/choice-groups.json の「同じ仲間の区分」から作り、正誤はユスティ（evaluate）だけで決める。AI は選択肢を作らない
// 正解がちょうど 1 つに決まらない箇所は問題にしない（ユスティが見ていない区分は間違いの選択肢にできない）
import { evaluate } from "../engine";
import type { ClaimContext, ClaimLine, Finding } from "../engine/types";
import { isCorrect } from "./practice";

/** その行を外す選択肢 */
export const NONE = "なし";
/** 必ず最後に付ける選択肢。選んでも正解にはならず、通常の画面（区分を自分で選ぶ・メンターに聞く）に戻る */
export const UNDECIDABLE = "判定不能";

export type ChoiceGroup = { name: string; options: string[] };
export type ChoiceItem = { lineIndex: number; group: string; options: string[] };
export type PickResult = { correct: boolean; findings: Finding[] };

function replaced(lines: ClaimLine[], i: number, option: string): ClaimLine[] {
  return option === NONE ? lines.filter((_, j) => j !== i) : lines.map((l, j) => (j === i ? { ...l, kubun: option } : l));
}

const okWith = (base: ClaimContext, i: number, option: string) => isCorrect(evaluate({ ...base, lines: replaced(base.lines, i, option) }));

/** 問題の一覧。base は UKE の原案（医療事務が入力した明細） */
export function choiceItems(base: ClaimContext, groups: ChoiceGroup[]): ChoiceItem[] {
  const out: ChoiceItem[] = [];
  base.lines.forEach((l, i) => {
    const g = groups.find((x) => x.options.includes(l.kubun));
    if (!g || g.options.length < 2) return;
    const right = g.options.filter((o) => okWith(base, i, o));
    if (right.length !== 1) return;
    out.push({ lineIndex: i, group: g.name, options: [...g.options, UNDECIDABLE] });
  });
  return out;
}

/** 本人が選んだ：その区分に入れ替えた明細をユスティにかける。間違いのときは、その指摘（情報不足を除く）を返す */
export function judgePick(base: ClaimContext, groups: ChoiceGroup[], lineIndex: number, option: string): PickResult {
  const item = choiceItems(base, groups).find((x) => x.lineIndex === lineIndex);
  if (!item) throw new Error(`選択の問題がない行: ${lineIndex}`);
  if (!item.options.includes(option)) throw new Error(`選択肢にない: ${option}`);
  if (option === UNDECIDABLE) return { correct: false, findings: [] };
  const r = evaluate({ ...base, lines: replaced(base.lines, lineIndex, option) });
  return { correct: isCorrect(r), findings: r.findings.filter((f) => f.kind !== "情報不足") };
}
