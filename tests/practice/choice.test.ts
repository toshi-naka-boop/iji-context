// 選択モード：区分を選ぶ箇所ごとに正解 1 つと間違えやすい区分を並べ、正誤はユスティだけで決める
import { describe, expect, it } from "vitest";
import groupsCfg from "../../config/choice-groups.json";
import { choiceItems, judgePick, UNDECIDABLE, type ChoiceGroup } from "../../src/practice/choice";
import { score, startQuestion, type Question } from "../../src/practice/practice";
import { loadCase } from "../engine/helpers";

const groups = groupsCfg.groups as ChoiceGroup[];
const right = (k: string) => {
  const c = loadCase(k);
  return choiceItems(c, groups).map((it) => ({ it, ok: it.options.filter((o) => judgePick(c, groups, it.lineIndex, o).correct) }));
};

describe("選択モードの問題", () => {
  it("K1〜K6 のどの問題も、正解はちょうど 1 つで、それは UKE の原案の区分。最後は必ず「判定不能」", () => {
    for (const k of ["K1", "K2", "K3", "K4", "K5", "K6"]) {
      const c = loadCase(k);
      for (const { it, ok } of right(k)) {
        expect(ok).toEqual([c.lines[it.lineIndex].kubun]);
        expect(it.options.at(-1)).toBe(UNDECIDABLE);
        expect(it.options.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("問題が作れる箇所：K1・K3・K4 は在医総管の区分、K2 は在医総管の区分と包括的支援加算。K5・K6 はなし", () => {
    const groupsOf = (k: string) => right(k).map((x) => x.it.group);
    expect(groupsOf("K1")).toEqual(["在医総管の区分"]);
    expect(groupsOf("K2")).toEqual(["在医総管の区分", "包括的支援加算"]);
    expect(groupsOf("K4")).toEqual(["在医総管の区分"]);
    expect(groupsOf("K5")).toEqual([]);
    expect(groupsOf("K6")).toEqual([]);
  });

  it("間違いを選ぶと、ユスティの指摘が理由として返る。判定不能は正解にならない", () => {
    const k2 = loadCase("K2");
    const kanri = choiceItems(k2, groups)[0];
    expect(judgePick(k2, groups, kanri.lineIndex, "C002_2NI1")).toMatchObject({ correct: false, findings: [expect.objectContaining({ ruleId: "R01" })] });
    expect(judgePick(k2, groups, kanri.lineIndex, UNDECIDABLE)).toEqual({ correct: false, findings: [] });
    const hokatsu = choiceItems(k2, groups)[1];
    expect(judgePick(k2, groups, hokatsu.lineIndex, "なし").findings.map((f) => f.ruleId)).toContain("R03");
    expect(() => judgePick(k2, groups, kanri.lineIndex, "C001_1I")).toThrow(/選択肢にない/);
    expect(() => judgePick(k2, groups, 0, "C002_2I1")).toThrow(/問題がない/);
  });
});

describe("選択モードのレベルの数え方", () => {
  it("選択モードで終えた 1 件は choiceWeight 件と数える。件数と連続正解は通常と同じ", () => {
    const done = (id: string, mode: "通常" | "選択"): Question => ({ ...startQuestion(id, "c1", "K1-2025-03", "2025-03-10T09:00:00+09:00", mode), phase: "完了", correct: true, finishedAt: `2025-03-10T09:0${id.length}:00+09:00` });
    expect(score([done("a", "通常"), done("bb", "選択"), done("ccc", "選択")], "c1", 0.5)).toEqual({ count: 3, credit: 2, streak: 3, bestStreak: 3 });
  });
});
