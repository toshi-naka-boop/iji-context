// 行ごとの印で、条件つきの指摘を確定と分けて数える（round-82 C-531）
import { describe, expect, it } from "vitest";
import { handMarksOf } from "../../src/uke/marks";

describe("handMarksOf", () => {
  it("条件つきは「条件つき n」に、確定は種類ごとに数える", () => {
    const f = [
      { kind: "要件不足" as const, lineRefs: ["C001_1I"], params: { conditional: "1" } },
      { kind: "要件不足" as const, lineRefs: ["C001_1I"] },
      { kind: "区分誤り" as const, lineRefs: ["C002_2RO1"] },
    ];
    expect(handMarksOf(f, ["C001_1I"])).toEqual({ kinds: { 要件不足: 1 }, conditional: 1 });
    expect(handMarksOf(f, ["C002_2RO1"])).toEqual({ kinds: { 区分誤り: 1 }, conditional: 0 });
  });
});
