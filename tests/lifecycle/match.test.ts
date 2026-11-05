// §7 #10：コメントと連続月の条件（design.md §3、v6）
import { describe, expect, it } from "vitest";
import { consecutiveMonths, matchState } from "../../src/lifecycle/match";
import { makeCtx, makeMeta } from "./helpers";

const BNP = "D008_18";

/** 3 か月連続で BNP を算定している固定のフィクスチャ（当月 2025-03 ＋ 過去 2 か月） */
const ctx3 = (withComment: boolean) =>
  makeCtx({
    kubun: [BNP],
    history: [
      { yearMonth: "2025-01", kubun: [BNP] },
      { yearMonth: "2025-02", kubun: [BNP] },
    ],
    comments: withComment ? [{ kubun: BNP, code: "800000001" }] : [],
  });

const region = { payer: "支払基金" as const, prefecture: "東京都" };
const avoid = makeMeta({ id: "regional/bnp-no-comment", polarity: "avoid", match: { kubunAll: [BNP], ...region, commentOn: [{ kubun: BNP, present: false }], consecutiveMonths: { kubun: BNP, min: 3 } } });
const allow = makeMeta({ id: "regional/bnp-comment", polarity: "allow", match: { kubunAll: [BNP], ...region, commentOn: [{ kubun: BNP, present: true }], consecutiveMonths: { kubun: BNP, min: 3 } } });

describe("commentOn", () => {
  it("コメントの有無で当てはまりが変わる", () => {
    expect(matchState(avoid, ctx3(false), [])).toBe("match");
    expect(matchState(avoid, ctx3(true), [])).toBe("nomatch");
    expect(matchState(allow, ctx3(true), [])).toBe("match");
    expect(matchState(allow, ctx3(false), [])).toBe("nomatch");
  });

  it("BNP の avoid／allow の組は、コメントの有無でちょうど片方だけ当てはまる", () => {
    for (const c of [true, false]) {
      const hits = [avoid, allow].filter((m) => matchState(m, ctx3(c), []) === "match");
      expect(hits).toHaveLength(1);
    }
  });
});

describe("consecutiveMonths", () => {
  it("history から当月を含めて数える", () => {
    expect(consecutiveMonths(ctx3(false), BNP)).toBe(3);
  });

  it("途切れたら数え直し", () => {
    const gap = makeCtx({
      kubun: [BNP],
      history: [
        { yearMonth: "2024-12", kubun: [BNP] },
        { yearMonth: "2025-01", kubun: [] },
        { yearMonth: "2025-02", kubun: [BNP] },
      ],
    });
    expect(consecutiveMonths(gap, BNP)).toBe(2);
    expect(matchState(avoid, gap, [])).toBe("nomatch");
  });

  it("当月に算定していなければ 0", () => {
    expect(consecutiveMonths(makeCtx({ kubun: ["C001"], history: [{ yearMonth: "2025-02", kubun: [BNP] }] }), BNP)).toBe(0);
  });

  it("年をまたいでも数える", () => {
    const ctx = makeCtx({
      kubun: [BNP],
      yearMonth: "2025-01",
      history: [
        { yearMonth: "2024-11", kubun: [BNP] },
        { yearMonth: "2024-12", kubun: [BNP] },
      ],
    });
    expect(consecutiveMonths(ctx, BNP)).toBe(3);
  });
});
