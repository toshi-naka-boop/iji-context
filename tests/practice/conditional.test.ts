// 条件つきの指摘（申告のとおりなら。R20・R21 など）を、本人の正誤・選択モード・本人のメモ・メンターへの文脈で確定の誤りとして扱わない（design.md §18-3 判断 F。round-82 C-540）
import { describe, expect, it } from "vitest";
import type { EngineResult, Finding } from "../../src/engine/types";
import { turnContext } from "../../src/mentor/prompt";
import { clerkMemo } from "../../src/mentor/workspace";
import { isCorrect } from "../../src/practice/practice";

const cond: Finding = { ruleId: "R20", kind: "要件不足", lineRefs: ["C010"], messageKey: "R20.renkei", params: { premise: "申告（…）のとおりなら", conditional: "1" }, reference: "x" };
const sure: Finding = { ruleId: "R05", kind: "背反", lineRefs: ["F400_3"], messageKey: "R05.bundled", reference: "x" };
const result = (findings: Finding[]): EngineResult => ({ claimId: "X", revisionId: "r2026", total: 0, byLine: [], findings, applied: ["R20"] });

describe("条件つきの指摘は確定の誤りではない（C-540）", () => {
  it("isCorrect：条件つきの指摘だけなら正解。確定の指摘があれば誤り", () => {
    expect(isCorrect(result([cond]))).toBe(true);
    expect(isCorrect(result([cond, sure]))).toBe(false);
  });
  it("本人のメモの「確認が入ったルール」に数えない", () => {
    const q = { confirmed: { result: result([cond]), lines: [], at: "" }, finishedAt: "x", startedAt: "x" } as never;
    expect(clerkMemo({ name: "新人", callName: "さん", role: "clerk", level: 1, count: 1, streak: 0 }, [q])).not.toContain("R20 1 回");
  });
  it("メンターへの文脈では、条件つきの印を渡し、申告の中身（前提の文）は渡さない", () => {
    const text = turnContext(result([cond]), true);
    expect(text).toContain('"conditional":true');
    expect(text).toContain("申告のとおりなら");
    expect(text).not.toContain("申告（…）");
  });
});
