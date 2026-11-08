// design.md §7 #1：R01〜R13 それぞれ「違反あり」「違反なし」（report-A 項目21 の 13 項目）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../../src/engine";
import type { ClaimContext, FindingKind } from "../../../src/engine/types";
import { line, loadCase, withEvents, withFact, withLines, without } from "../helpers";

const K1 = loadCase("K1");
const K2 = loadCase("K2");
/** 在医総管のない月（処方箋料を算定できる）。R06・R07 の確認用 */
const NO_KANRI = withLines(
  without(K1, "C002_2I1", "C002_N15_RENKEI"),
  line("F400_3", 1, ["2025-03-26"]),
  line("F400_N4", 1, ["2025-03-26"]),
  line("F400_N6_1", 1, ["2025-03-26"]),
);

function kinds(ctx: ClaimContext, ruleId: string): FindingKind[] {
  return evaluate(ctx).findings.filter((f) => f.ruleId === ruleId).map((f) => f.kind);
}

type Case = { id: string; ok: ClaimContext; ng: ClaimContext; kind: FindingKind };

const cases: Case[] = [
  // 1 訪問診療なしの在医総管
  { id: "R01", ok: K1, ng: without(K1, "C001_1I", "O100_3I"), kind: "区分誤り" },
  // 2 在宅酸素中なのに 3,685 で請求
  { id: "R02", ok: K1, ng: withLines(without(K1, "C002_2I1"), line("C002_2RO1")), kind: "区分誤り" },
  // 3 要介護 2 で包括的支援加算
  { id: "R03", ok: K2, ng: withFact(K2, "careLevel", { known: true, value: 2 }), kind: "要件不足" },
  // 4 HOT と自己注射の指導管理料を両方
  { id: "R04", ok: K1, ng: withLines(K1, line("C101_2I")), kind: "背反" },
  // 5 在医総管の月に特定疾患療養管理料
  { id: "R05", ok: K1, ng: withLines(K1, line("B000")), kind: "背反" },
  // 6 主病が糖尿病で特定疾患処方管理加算
  {
    id: "R06",
    ok: NO_KANRI,
    ng: withLines(without(K2, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU"), line("F400_3", 1, ["2025-03-26"]), line("F400_N4", 1, ["2025-03-26"])),
    kind: "要件不足",
  },
  // 7 内服 7 種類以上なのに 60 点の区分
  {
    id: "R07",
    ok: NO_KANRI,
    ng: { ...NO_KANRI, events: NO_KANRI.events.map((e) => (e.type === "prescription" ? { ...e, oralKinds: 7 } : e)) },
    kind: "区分誤り",
  },
  // 8 往診のみの日に訪問診療時 28 点
  {
    id: "R08",
    ok: K1,
    ng: withEvents(
      { ...K1, lines: K1.lines.map((l) => (l.kubun === "O100_3I" ? { ...l, count: 3, dates: [...l.dates, "2025-03-20"] } : l)) },
      { type: "oushin", date: "2025-03-20", kind: "normal" },
    ),
    kind: "区分誤り",
  },
  // 9 看取り加算と死亡診断加算を両方
  {
    id: "R09",
    ok: withEvents(withLines(K1, line("C001_N7_MITORI", 1, ["2025-03-26"])), { type: "death", date: "2025-03-26" }),
    ng: withEvents(withLines(K1, line("C001_N7_MITORI", 1, ["2025-03-26"]), line("C001_N8_SHIBOU", 1, ["2025-03-26"])), {
      type: "death",
      date: "2025-03-26",
    }),
    kind: "背反",
  },
  // 10 訪問診療と同日の往診
  {
    id: "R10",
    ok: withEvents(withLines(K1, line("C000", 1, ["2025-03-20"])), { type: "oushin", date: "2025-03-20", kind: "normal" }),
    ng: withEvents(withLines(K1, line("C000", 1, ["2025-03-12"])), { type: "oushin", date: "2025-03-12", kind: "normal" }),
    kind: "要件不足",
  },
  // 11 BNP に生化学(Ⅰ)判断料だけ
  { id: "R11", ok: K1, ng: without(K1, "D026_5"), kind: "区分誤り" },
  // 12 DX 情報活用加算と医療情報取得加算を同月
  { id: "R12", ok: K1, ng: withLines(K1, line("A_IRYOJOHO")), kind: "背反" },
  // 13 例外疾病でないのに週 4 回の訪問
  {
    id: "R13",
    ok: K1,
    ng: withEvents(
      K1,
      ...["2025-03-10", "2025-03-11", "2025-03-13"].map((date) => ({ type: "visit" as const, date, sameBuildingCount: 1 })),
    ),
    kind: "要件不足",
  },
];

describe.each(cases)("$id", ({ id, ok, ng, kind }) => {
  it("違反なし", () => {
    expect(kinds(ok, id)).toEqual([]);
    expect(evaluate(ok).applied).toContain(id);
  });
  it("違反あり", () => {
    expect(kinds(ng, id)).toContain(kind);
  });
});

describe("R05 処方箋料（EM #7-6、問66）", () => {
  it("在医総管の月に処方箋料と、それに付く加算を立てると背反", () => {
    const f = evaluate(withLines(K1, line("F400_3", 1, ["2025-03-26"]), line("F400_N4", 1, ["2025-03-26"]))).findings.filter((x) => x.ruleId === "R05");
    expect(f).toEqual([expect.objectContaining({ kind: "背反", lineRefs: ["F400_3", "F400_N4"] })]);
  });
  it("在医総管のない月の処方箋料は指摘しない", () => {
    expect(kinds(NO_KANRI, "R05")).toEqual([]);
  });
});

describe("R13 の例外", () => {
  it("別表第七なら週 4 回でも指摘しない", () => {
    const ng = cases.find((c) => c.id === "R13")!.ng;
    expect(kinds(withFact(ng, "table7", { known: true, value: true }), "R13")).toEqual([]);
  });
});

describe("未知の区分", () => {
  it("例外を投げる（0 点にしない）", () => {
    expect(() => evaluate(withLines(K1, line("XXXX")))).toThrow();
  });
});
