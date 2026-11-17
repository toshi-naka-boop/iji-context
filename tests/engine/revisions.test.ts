// §7 #12a：改定の版の仕組み（design.md §2-5）。作り物の版で確かめ、EM の採用値は使わない
import { describe, expect, it } from "vitest";
import { evaluate, ruleKubun, rulesOf } from "../../src/engine";
import { assertRevisions, hasRevision, pointsOf, resolveRevision, REVISIONS } from "../../src/engine/revisions";
import { makeCtx } from "../lifecycle/helpers";
import { FAKE_A, FAKE_B, FAKE_REVISIONS, fakeRevision } from "./fake-revisions";

describe("点数表の名称", () => {
  it("どの版でも、区分の名称は版の中で一意（査定・返戻の通知の項目名から区分を 1 つに決めるため）", () => {
    for (const rev of REVISIONS) {
      const names = Object.values(rev.points).map((d) => d.name);
      expect(new Set(names).size, rev.id).toBe(names.length);
    }
  });
});

describe("仕組み", () => {
  it("境界の前後：前の版の終了月と次の版の開始月が、それぞれの版に解決される", () => {
    expect(resolveRevision("2030-01", FAKE_REVISIONS).id).toBe("fake-a");
    expect(resolveRevision("2030-12", FAKE_REVISIONS).id).toBe("fake-a");
    expect(resolveRevision("2031-01", FAKE_REVISIONS).id).toBe("fake-b");
    expect(resolveRevision("2031-12", FAKE_REVISIONS).id).toBe("fake-b");
  });

  it("期間の外は例外（近い版で代用しない）。形式違いの年月も例外", () => {
    for (const ym of ["2029-12", "2032-01"]) {
      expect(() => resolveRevision(ym, FAKE_REVISIONS)).toThrow(/版がない/);
      expect(hasRevision(ym, FAKE_REVISIONS)).toBe(false);
    }
    for (const ym of ["2030-1", "2030-13", "2030-00", "203001", "2030-01-01", ""]) {
      expect(() => resolveRevision(ym, FAKE_REVISIONS)).toThrow(/形式/);
      expect(hasRevision(ym, FAKE_REVISIONS)).toBe(false);
    }
    expect(hasRevision("2030-06", FAKE_REVISIONS)).toBe(true);
  });

  it("重なり・空白・id の重複・開始月が終了月より後の版は assertRevisions が例外", () => {
    expect(() => assertRevisions(FAKE_REVISIONS)).not.toThrow();
    expect(() => assertRevisions([FAKE_A, fakeRevision({ id: "overlap", effectiveFrom: "2030-12", effectiveUntil: "2031-12" })])).toThrow(/重なる/);
    expect(() => assertRevisions([FAKE_A, fakeRevision({ id: "gap", effectiveFrom: "2031-02", effectiveUntil: "2031-12" })])).toThrow(/空白/);
    expect(() => assertRevisions([FAKE_A, { ...FAKE_B, id: "fake-a" }])).toThrow(/重複/);
    expect(() => assertRevisions([fakeRevision({ id: "reversed", effectiveFrom: "2030-12", effectiveUntil: "2030-01" })])).toThrow(/終了月より後/);
  });

  it("ルールの区分が自分の点数表にない版は assertRevisions が例外", () => {
    const bad = { ...FAKE_A, rules: FAKE_B.rules };
    expect(() => assertRevisions([bad])).toThrow(/点数表にない/);
  });

  it("値の変更の版は、同じ改定の直前の版と区分の集合が同じでなければ例外", () => {
    const sameKeys = fakeRevision({ id: "fake-a2", generation: "fake-a", kind: "値の変更", effectiveFrom: "2031-01", effectiveUntil: "2031-12" }, "X1", 12, 1);
    expect(() => assertRevisions([FAKE_A, sameKeys])).not.toThrow();
    const otherKeys = fakeRevision({ id: "fake-a2", generation: "fake-a", kind: "値の変更", effectiveFrom: "2031-01", effectiveUntil: "2031-12" }, "X2", 12, 1);
    expect(() => assertRevisions([FAKE_A, otherKeys])).toThrow(/区分の集合/);
    expect(() => assertRevisions([FAKE_A, { ...sameKeys, generation: "other" }])).toThrow(/直前の版がない/);
  });

  it("同梱の REVISIONS が assertRevisions を通る。どの版でも、ルールの id は重複しない", () => {
    expect(REVISIONS.length).toBeGreaterThan(0);
    expect(() => assertRevisions(REVISIONS)).not.toThrow();
    for (const rev of REVISIONS) expect(new Set(rev.rules.map((r) => r.id)).size).toBe(rev.rules.length);
  });

  it("evaluate(ctx, 作り物の版) の合計と指摘が版で変わり、使った版の id が返る", () => {
    const a = evaluate({ ...makeCtx({ yearMonth: "2030-06" }), lines: [{ kubun: "X1", count: 2, dates: ["2030-06-01", "2030-06-02"] }] }, FAKE_REVISIONS);
    expect(a).toMatchObject({ revisionId: "fake-a", total: 20, applied: ["F01"], excludedCount: 0 });
    expect(a.findings.map((f) => f.messageKey)).toEqual(["F01.over"]);
    const b = evaluate({ ...makeCtx({ yearMonth: "2031-06" }), lines: [{ kubun: "X2", count: 2, dates: ["2031-06-01", "2031-06-02"] }] }, FAKE_REVISIONS);
    expect(b).toMatchObject({ revisionId: "fake-b", total: 50, applied: ["F01"], excludedCount: 0 });
    expect(b.findings).toEqual([]);
  });

  it("その版にない区分・版のない診療年月の evaluate は例外（黙って 0 点にしない）", () => {
    expect(() => evaluate({ ...makeCtx({ yearMonth: "2031-06" }), lines: [{ kubun: "X1", count: 1, dates: ["2031-06-01"] }] }, FAKE_REVISIONS)).toThrow(/未知の区分/);
    expect(() => evaluate({ ...makeCtx({ yearMonth: "2032-01" }), lines: [] }, FAKE_REVISIONS)).toThrow(/版がない/);
    expect(() => pointsOf(FAKE_A, "X2")).toThrow(/未知の区分/);
  });

  it("判定の対象外の行（excluded）があれば、合計は出さず、行数を返す", () => {
    const r = evaluate({ ...makeCtx({ yearMonth: "2030-06" }), lines: [{ kubun: "X1", count: 1, dates: ["2030-06-01"] }], excluded: [{ code: "990009999", count: 1 }] }, FAKE_REVISIONS);
    expect(r.total).toBeNull();
    expect(r.excludedCount).toBe(1);
  });

  it("rulesOf・ruleKubun は診療年月の版から取る。その版にないルールは空配列、版のない年月は例外", () => {
    expect(rulesOf("2030-06", FAKE_REVISIONS).map((r) => r.id)).toEqual(["F01"]);
    expect(ruleKubun("F01", "2030-06", FAKE_REVISIONS)).toEqual(["X1"]);
    expect(ruleKubun("F01", "2031-06", FAKE_REVISIONS)).toEqual(["X2"]);
    expect(ruleKubun("F99", "2030-06", FAKE_REVISIONS)).toEqual([]);
    expect(() => ruleKubun("F01", "2032-01", FAKE_REVISIONS)).toThrow(/版がない/);
  });
});
