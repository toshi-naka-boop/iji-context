// 訪問の時点（レセコンに入れる前）の点検：その日までの実施だけにして、月末まで決まらないルールは指摘にしない（FR-68）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { ClaimContext } from "../../src/engine/types";
import { contextAsOf, DEFERRED_RULES, deferAtMidMonth, outlook, visitDays } from "../../src/visit/as-of";
import k3 from "../../fixtures/cases/K3.json";
import { loadCase } from "../engine/helpers";
import { dateIn, day } from "../helpers/period";

const K3 = k3 as unknown as ClaimContext;
const K4 = loadCase("K4");

describe("その日までの実施", () => {
  it("K3 の 3 回目の訪問の時点は、その日までの行だけで、月末の在医総管はまだない", () => {
    const c = contextAsOf(K3, day(7));
    const three = [day(5), day(6), day(7)];
    expect(c.lines).toEqual([
      { kubun: "C001_1I", count: 3, dates: three },
      { kubun: "O001_3I", count: 3, dates: three },
      { kubun: "O100_1HA", count: 3, dates: three },
      { kubun: "C001_N13_DX", count: 1, dates: [day(5)] },
    ]);
    expect(c.events.every((e) => !("date" in e) || e.date <= day(7))).toBe(true);
    expect(c.facts.visitsComplete).toEqual({ known: true, value: false });
  });
  it("訪問日の一覧は訪問診療と往診の日", () => {
    expect(visitDays(K4).map((d) => d.date)).toEqual([day(13), day(27)]);
  });
  it("診療月の外の日は受けない", () => {
    expect(() => contextAsOf(K4, dateIn(1, 1))).toThrow();
  });
});

describe("月の途中の判定", () => {
  it("在医総管の区分（R01）は月の途中では指摘にせず、見込みとして出す", () => {
    const c = contextAsOf(K4, day(13));
    const ctx = { ...c, lines: [...c.lines, { kubun: "C002-2_2RO1", count: 1, dates: [day(13)] }] };
    expect(evaluate(ctx).findings.some((f) => f.ruleId === "R01")).toBe(true);
    expect(deferAtMidMonth(evaluate(ctx)).findings.some((f) => f.ruleId === "R01")).toBe(false);
    expect(outlook(K4, day(13))).toContain("ここまで 1 回");
  });
  it("月の途中は R01・R03・R09 を伏せる（R03 は、回数で決まる管理料の区分に依るため）", () => {
    expect(DEFERRED_RULES).toEqual(["R01", "R03", "R09"]);
  });
});

describe("月の途中の K1（重症・要介護 3）：どの行を入れても指摘が往復しない（design.md §2-3-3 の K1 の表。C-68）", () => {
  const K1 = loadCase("K1");
  const KANRI = ["C002_2I1", "C002_2RO1", "C002_2NI1"];
  /** その日までの実施に、管理料（と包括的支援加算）を手で入れた請求 */
  const entered = (asOf: string, kanri: string, add: boolean): ClaimContext => {
    const c = contextAsOf(K1, asOf);
    const lines = [...c.lines.filter((l) => !KANRI.includes(l.kubun) && l.kubun !== "C002_N15_RENKEI"), { kubun: kanri, count: 1, dates: [asOf] }];
    return { ...c, lines: add ? [...lines, { kubun: "C002_N10_HOKATSU", count: 1, dates: [asOf] }] : lines };
  };
  const tags = (c: ClaimContext) => deferAtMidMonth(evaluate(c)).findings.map((f) => `${f.ruleId}:${f.kind}:${f.messageKey.split(".")[1]}`);

  it("1 回目の訪問診療の後（回数 1）は、管理料 イ・ロ・ニ と加算の有無の 6 通りで、どれも 0 件", () => {
    for (const kanri of KANRI) for (const add of [false, true]) expect(tags(entered(day(14), kanri, add)), `${kanri} ${add}`).toEqual([]);
  });
  it("2 回目の訪問診療料の後（回数 2）は、表の「回数 2」の行のとおり", () => {
    expect(tags(entered(day(28), "C002_2I1", false))).toEqual([]);
    expect(tags(entered(day(28), "C002_2I1", true))).toEqual(["R02:背反:severe_with_hokatsu"]);
    for (const kanri of ["C002_2RO1", "C002_2NI1"]) {
      expect(tags(entered(day(28), kanri, false))).toEqual(["R02:区分誤り:use_severe"]);
      expect(tags(entered(day(28), kanri, true))).toEqual(["R02:区分誤り:use_severe", "R02:背反:severe_with_hokatsu"]);
    }
  });
});
