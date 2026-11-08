// 訪問の時点（レセコンに入れる前）の点検：その日までの実施だけにして、月末まで決まらないルールは指摘にしない（FR-68）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { ClaimContext } from "../../src/engine/types";
import { contextAsOf, deferAtMidMonth, outlook, visitDays } from "../../src/visit/as-of";
import k3 from "../../fixtures/cases/K3.json";
import k4 from "../../fixtures/cases/K4.json";

const K3 = k3 as unknown as ClaimContext;
const K4 = { ...(k4 as unknown as ClaimContext), facility: { zaishishin: true } } as unknown as ClaimContext;

describe("その日までの実施", () => {
  it("K3 の 3/5 時点は訪問診療 3 回だけで、月末の在医総管はまだない", () => {
    const c = contextAsOf(K3, "2025-03-05");
    expect(c.lines).toEqual([{ kubun: "C001_1I", count: 3, dates: ["2025-03-03", "2025-03-04", "2025-03-05"] }]);
    expect(c.events.every((e) => !("date" in e) || e.date <= "2025-03-05")).toBe(true);
    expect(c.facts.visitsComplete).toEqual({ known: true, value: false });
  });
  it("訪問日の一覧は訪問診療と往診の日", () => {
    expect(visitDays(K4).map((d) => d.date)).toEqual(["2025-03-11", "2025-03-25"]);
  });
  it("診療月の外の日は受けない", () => {
    expect(() => contextAsOf(K4, "2025-04-01")).toThrow();
  });
});

describe("月の途中の判定", () => {
  it("在医総管の区分（R01）は月の途中では指摘にせず、見込みとして出す", () => {
    const c = contextAsOf(K4, "2025-03-11");
    const ctx = { ...c, lines: [...c.lines, { kubun: "C002_2RO1", count: 1, dates: ["2025-03-11"] }] };
    expect(evaluate(ctx).findings.some((f) => f.ruleId === "R01")).toBe(true);
    expect(deferAtMidMonth(evaluate(ctx)).findings.some((f) => f.ruleId === "R01")).toBe(false);
    expect(outlook(K4, "2025-03-11")).toContain("ここまで 1 回");
  });
});
