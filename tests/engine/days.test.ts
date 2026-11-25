// 指摘の days（design.md §15-8。round-52 C-260・X-149、round-53 C-272。段 18c）：日・週で決まる指摘を出す R10・R13 だけが、その指摘が関わる算定日を持つ。
// ほかのルールは持たない。days は内部の欄で、指摘の数・文・確度を変えない（K1〜K7 の結果はほかのテストが縛ったまま）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { ClaimContext, ClaimLine } from "../../src/engine/types";
import { findingText } from "../../src/messages";
import { day } from "../helpers/period";
import { loadCase } from "./helpers";

const L = (kubun: string, ...ds: number[]): ClaimLine => ({ kubun, count: ds.length, dates: ds.map(day) });
/** K8 の文脈（在支診）に、行と事実を書く。R10・R13 の事実はテストごとに明記する */
function ctxOf(lines: ClaimLine[], facts: Partial<ClaimContext["facts"]>, facility: Partial<ClaimContext["facility"]> = {}): ClaimContext {
  const k8 = loadCase("K8");
  return { ...k8, lines, events: [], recordsKnown: false, facts: { ...k8.facts, ...facts }, facility: { ...k8.facility, ...facility } };
}
const R10_FACTS = { sameDaySeparate: { known: true as const, value: {} as Record<string, boolean> }, sameDayOushinAfterVisit: { known: true as const, value: {} as Record<string, boolean> }, contactDocProvided: { known: true as const, value: true } };
const of = (ctx: ClaimContext, key: string) => evaluate(ctx).findings.filter((f) => f.messageKey === key);

describe("R10 の days", () => {
  it("same_encounter はその日、oushin_not_after_visit はその日、same_day_as_visit は c1 の日、visit_day_after_oushin は d1 の日", () => {
    const same = ctxOf([L("C000", 9), L("C001_1I", 9, 20)], { ...R10_FACTS, sameDaySeparate: { known: true, value: { [day(9)]: false } } });
    expect(of(same, "R10.same_encounter").map((f) => f.days)).toEqual([[day(9)]]);
    const notAfter = ctxOf([L("C000", 9), L("C001_1I", 9, 20)], { ...R10_FACTS, sameDaySeparate: { known: true, value: { [day(9)]: true } }, sameDayOushinAfterVisit: { known: true, value: { [day(9)]: false } } });
    expect(of(notAfter, "R10.oushin_not_after_visit").map((f) => f.days)).toEqual([[day(9)]]);
    const c1 = ctxOf([L("C000", 9), L("C001_1I", 9, 20)], { ...R10_FACTS, sameDaySeparate: { known: true, value: { [day(9)]: true } }, sameDayOushinAfterVisit: { known: true, value: { [day(9)]: true } }, contactDocProvided: { known: true, value: false } });
    expect(of(c1, "R10.same_day_as_visit").map((f) => f.days)).toEqual([[day(9)]]);
    const d1 = ctxOf([L("C000", 9), L("C001_1I", 10, 20)], R10_FACTS, { zaishishin: false, grade: { known: true, value: "3" } });
    expect(of(d1, "R10.visit_day_after_oushin").map((f) => f.days)).toEqual([[day(10)]]);
  });
  it("事実が分からない情報不足は missing.date で日を持ち、在支診かの文書の情報不足は日を持たない", () => {
    const unknown = ctxOf([L("C000", 9), L("C001_1I", 9, 20)], { ...R10_FACTS, sameDayOushinAfterVisit: { known: true, value: { [day(9)]: false } } });
    expect(of(unknown, "R10.missing_fact").map((f) => [f.missing?.field, f.missing?.date, f.days])).toEqual([["sameDaySeparate", day(9), undefined]]);
    const doc = ctxOf([L("C000", 9), L("C001_1I", 10, 20)], { ...R10_FACTS, contactDocProvided: { known: false } });
    expect(of(doc, "R10.missing_fact").map((f) => [f.missing?.field, f.missing?.date, f.days])).toEqual([["contactDocProvided", undefined, undefined]]);
  });
});

describe("R13 の days", () => {
  // 2026 年 10 月：4 日（日）〜10 日（土）と 18 日〜24 日が 1 つの週
  const over = [L("C001_1I", 5, 6, 7, 8, 18, 19, 20, 21)];
  it("over_three_a_week は、上限を超えた週の算定日の全部（2 つの週が超えれば両方）", () => {
    const ctx = ctxOf(over, { table7: { known: true, value: false }, acuteExacerbation: { known: true, value: false } });
    expect(of(ctx, "R13.over_three_a_week").map((f) => f.days)).toEqual([[5, 6, 7, 8, 18, 19, 20, 21].map(day)]);
  });
  it("table7・acuteExacerbation が分からない情報不足（エンジンの needs の道）も、上限を超えた週の算定日の全部を持つ", () => {
    const ctx = ctxOf(over, { table7: { known: false }, acuteExacerbation: { known: false } });
    expect(of(ctx, "R13.missing_fact").map((f) => f.days)).toEqual([[5, 6, 7, 8, 18, 19, 20, 21].map(day)]);
  });
});

describe("ほかのルールは days を持たない・文は変わらない", () => {
  it("K1〜K7 の指摘で days を持つのは R10・R13 だけで、days を外した文は同じ", () => {
    for (const k of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) {
      const fs = evaluate(loadCase(k)).findings;
      expect([k, fs.filter((f) => f.days !== undefined && !["R10", "R13"].includes(f.ruleId))]).toEqual([k, []]);
      expect(fs.map((f) => findingText(f))).toEqual(fs.map(({ days: _d, ...f }) => findingText(f)));
    }
  });
});
