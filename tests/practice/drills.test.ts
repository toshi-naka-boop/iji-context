// 練習問題（FR-75）：どの問題も、ねらいのルールでユスティが指摘する。答えを一覧に出さない
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { DRILLS, drillList } from "../../src/practice/drills";
import { loadCase } from "../engine/helpers";

describe("練習問題", () => {
  it.each(DRILLS)("$id は $ruleId で指摘される", (d) => {
    const ctx = d.make(loadCase(d.claimId.split("-")[0]));
    const f = evaluate(ctx).findings;
    expect(f.map((x) => x.ruleId)).toContain(d.ruleId);
    // ねらい以外のルールの指摘が混ざっていない（混ざると練習の焦点がぼける）
    expect(f.filter((x) => x.ruleId !== d.ruleId && x.kind !== "情報不足").map((x) => x.ruleId)).toEqual([]);
  });
  it("一覧にはルール（答え）を出さない", () => {
    expect(JSON.stringify(drillList())).not.toMatch(/R\d\d/);
    expect(drillList()).toHaveLength(12);
  });
});
