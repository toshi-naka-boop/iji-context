// F7 処理体験と F10 レベル（spec FR-16・FR-28・FR-29、impl-plan 11/7 の完了条件の決定的な部分）
import { describe, expect, it } from "vitest";
import levels from "../../config/levels.json";
import { checkDraft, confirm, finish, levelOf, myStatus, score, startQuestion, toExplanation, type Question } from "../../src/practice/practice";
import { loadCase, without } from "../engine/helpers";

const T = (d: string, h = "09") => `2025-03-${d}T${h}:00:00+09:00`;
const th = levels.thresholds;

/** 1 問を最後まで進める */
function solve(id: string, clerk: string, k: string, at: string, broken = false): Question {
  const ctx = loadCase(k);
  let q = startQuestion(id, clerk, ctx.claimId, at);
  q = confirm(q, broken ? without(ctx, "C002_N10_HOKATSU") : ctx, at);
  q = toExplanation(q);
  return finish(q, at);
}

describe("1 問の流れ（FR-28）", () => {
  it("ヒント → 確定（エンジンが判定）→ 解説 → 完了の順で、飛ばすと例外", () => {
    const ctx = loadCase("K2");
    const q = startQuestion("q1", "c1", ctx.claimId, T("10"));
    expect(() => toExplanation(q)).toThrow(/解説に進めない/);
    expect(() => finish(q, T("10"))).toThrow(/終えられない/);
    const c = confirm(q, ctx, T("10"));
    expect(c).toMatchObject({ phase: "判定", correct: true });
    expect(() => confirm(c, ctx, T("10"))).toThrow(/確定できない/);
    expect(finish(toExplanation(c), T("10")).phase).toBe("完了");
  });

  it("確定した請求に指摘があれば不正解。情報不足だけなら正解（本人の誤りではない）", () => {
    const k2 = loadCase("K2");
    expect(confirm(startQuestion("a", "c1", k2.claimId, T("10")), without(k2, "C002_N10_HOKATSU"), T("10")).correct).toBe(false);
    const k4 = loadCase("K4"); // 要介護度が不明で情報不足が 1 件出る
    expect(confirm(startQuestion("b", "c1", k4.claimId, T("10")), k4, T("10")).correct).toBe(true);
  });

  it("ヒントの段階の下書きの指摘が記録される（F9 の「提出前に指摘した」の元）", () => {
    const k2 = loadCase("K2");
    const { question, result } = checkDraft(startQuestion("q", "c1", k2.claimId, T("10")), without(k2, "C002_N10_HOKATSU"), T("10"));
    expect(result.findings.map((f) => f.ruleId)).toContain("R03");
    expect(question.drafts).toHaveLength(1);
  });

  it("別の請求で確定・下書きはできない", () => {
    const q = startQuestion("q", "c1", "K1-2025-03", T("10"));
    expect(() => confirm(q, loadCase("K2"), T("10"))).toThrow(/別の請求/);
  });
});

describe("スコア（件数・連続正解。FR-29）とレベル（FR-16）", () => {
  it("K1〜K6 を順に解くと件数と連続正解が増え、間違えると連続正解が 0 に戻る", () => {
    const qs: Question[] = [];
    ["K1", "K2", "K3", "K4", "K5", "K6"].forEach((k, i) => qs.push(solve(`q${i}`, "c1", k, T(String(10 + i)))));
    expect(score(qs, "c1")).toEqual({ count: 6, streak: 6, bestStreak: 6 });
    qs.push(solve("q6", "c1", "K2", T("20"), true));
    expect(score(qs, "c1")).toEqual({ count: 7, streak: 0, bestStreak: 6 });
    expect(Object.keys(score(qs, "c1")).some((k) => /yen|amount|金額/.test(k))).toBe(false);
  });

  it("レベルは処理件数の累計で Lv.1〜10。しきい値ちょうどで上がる", () => {
    expect([0, 19, 20, 49, 50, 999, 1000, 5000].map((n) => levelOf(n, th))).toEqual([1, 1, 2, 2, 3, 9, 10, 10]);
    expect(() => levelOf(-1, th)).toThrow();
    expect(() => levelOf(1, [0, 1, 1, 2, 3, 4, 5, 6, 7, 8])).toThrow(/増加列/);
  });

  it("本人向けの状態は自分のレベルだけを返し、他人のレベルは含まない", () => {
    const qs = [solve("a", "c1", "K1", T("10")), solve("b", "c2", "K2", T("10")), solve("c", "c2", "K3", T("11"))];
    expect(myStatus(qs, "c1", th)).toEqual({ level: 1, count: 1, streak: 1 });
    expect(JSON.stringify(myStatus(qs, "c1", th))).not.toContain("c2");
  });
});
