// §7 #12a・#12b：改定の版の仕組み（design.md §2-5）。仕組みは作り物の版で確かめ、EM の採用値は使わない。同梱の版は境界と差分を確かめる
import { describe, expect, it } from "vitest";
import { evaluate, ruleKubun, rulesOf } from "../../src/engine";
import { assertRevisions, hasRevision, pointsOf, resolveRevision, REVISIONS } from "../../src/engine/revisions";
import { r2026 } from "../../src/engine/revisions/r2026";
import { r2027_06 } from "../../src/engine/revisions/r2027-06";
import { extendRevision } from "../../src/engine/revisions/extend";
import { latestRevision, type Calendar } from "../../src/lifecycle/calendar";
import calendar from "../../config/calendar.json";
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
    expect(a).toMatchObject({ revisionId: "fake-a", total: 20, applied: ["F01"] });
    expect(a.findings.map((f) => f.messageKey)).toEqual(["F01.over"]);
    const b = evaluate({ ...makeCtx({ yearMonth: "2031-06" }), lines: [{ kubun: "X2", count: 2, dates: ["2031-06-01", "2031-06-02"] }] }, FAKE_REVISIONS);
    expect(b).toMatchObject({ revisionId: "fake-b", total: 50, applied: ["F01"] });
    expect(b.findings).toEqual([]);
  });

  it("その版にない区分・版のない診療年月の evaluate は例外（黙って 0 点にしない）", () => {
    expect(() => evaluate({ ...makeCtx({ yearMonth: "2031-06" }), lines: [{ kubun: "X1", count: 1, dates: ["2031-06-01"] }] }, FAKE_REVISIONS)).toThrow(/未知の区分/);
    expect(() => evaluate({ ...makeCtx({ yearMonth: "2032-01" }), lines: [] }, FAKE_REVISIONS)).toThrow(/版がない/);
    expect(() => pointsOf(FAKE_A, "X2")).toThrow(/未知の区分/);
  });

  it("rulesOf・ruleKubun は診療年月の版から取る。その版にないルールは空配列、版のない年月は例外", () => {
    expect(rulesOf("2030-06", FAKE_REVISIONS).map((r) => r.id)).toEqual(["F01"]);
    expect(ruleKubun("F01", "2030-06", FAKE_REVISIONS)).toEqual(["X1"]);
    expect(ruleKubun("F01", "2031-06", FAKE_REVISIONS)).toEqual(["X2"]);
    expect(ruleKubun("F99", "2030-06", FAKE_REVISIONS)).toEqual([]);
    expect(() => ruleKubun("F01", "2032-01", FAKE_REVISIONS)).toThrow(/版がない/);
  });
});

describe("同梱の版", () => {
  it("2027-05 は r2026、2027-06 は r2027-06。開始月 2026-06 と終了月 2028-05 も含む", () => {
    expect(resolveRevision("2026-06").id).toBe("r2026");
    expect(resolveRevision("2026-10").id).toBe("r2026");
    expect(resolveRevision("2027-05").id).toBe("r2026");
    expect(resolveRevision("2027-06").id).toBe("r2027-06");
    expect(resolveRevision("2028-05").id).toBe("r2027-06");
  });
  it("期間の外は例外（2026-05・2028-06。前の年度の 2025-03 も）。近い版で代用しない", () => {
    for (const ym of ["2026-05", "2028-06", "2025-03"]) {
      expect(() => resolveRevision(ym)).toThrow(/版がない/);
      expect(hasRevision(ym)).toBe(false);
    }
  });
  it("同梱する版は令和8年度改定後の 2 つだけ（前の年度の版は持たない）", () => {
    expect(REVISIONS.map((r) => [r.id, r.generation, r.kind])).toEqual([
      ["r2026", "R8", "改定"],
      ["r2027-06", "R8", "値の変更"],
    ]);
  });
  it("r2027-06 は r2026 と区分の集合・定数・ルールが同じで、点数が違うのは差分に書いた区分だけ（EM §2-3 の N-1〜N-7）", () => {
    expect(Object.keys(r2027_06.points).sort()).toEqual(Object.keys(r2026.points).sort());
    expect(r2027_06.consts).toBe(r2026.consts);
    expect(r2027_06.rules).toBe(r2026.rules);
    // 診療行為コードも引き継ぐ（design.md §11-1）
    expect([r2027_06.codes, r2027_06.bundles, r2027_06.uncoded, r2027_06.shikibetsu]).toEqual([r2026.codes, r2026.bundles, r2026.uncoded, r2026.shikibetsu]);
    const changed = Object.keys(r2026.points).filter((k) => r2026.points[k].points !== r2027_06.points[k].points);
    expect(changed.sort()).toEqual(["O001_1", "O001_1_N5", "O001_2", "O001_2_N5", "O001_3I", "O001_3I_N5", "O001_3RO", "O001_3RO_N5", "O100_1HA", "O100_1I", "O100_1RO"]);
    const pair = (k: string) => [pointsOf(r2026, k), pointsOf(r2027_06, k)];
    expect(pair("O001_1")).toEqual([17, 34]);
    expect(pair("O001_2")).toEqual([4, 8]);
    expect(pair("O001_3I")).toEqual([79, 158]);
    expect(pair("O001_3RO")).toEqual([19, 38]);
    // 注5 の区分（EM §2-3 N-1〜N-4 の括弧の値）
    expect(["O001_1_N5", "O001_2_N5", "O001_3I_N5", "O001_3RO_N5"].map(pair)).toEqual([
      [23, 40],
      [6, 10],
      [107, 186],
      [26, 45],
    ]);
    expect(pair("O100_1I")).toEqual([2, 4]);
    expect(pair("O100_1RO")).toEqual([2, 4]);
    expect(pair("O100_1HA")).toEqual([3, 6]);
    // 名称・区分番号・出典は変わらない
    for (const k of changed) expect({ ...r2027_06.points[k], points: 0 }).toEqual({ ...r2026.points[k], points: 0 });
  });
  it("差分の版は、直前の版にない区分を足せない。直前の版の点数表は書き換わらない", () => {
    const diff = { id: "x", label: "x", effectiveFrom: "2027-06", effectiveUntil: "2028-05" };
    expect(() => extendRevision(r2026, { ...diff, points: { NEW_KUBUN: 1 } })).toThrow(/足せない/);
    expect(pointsOf(r2026, "O001_3I")).toBe(79);
  });
  it("「改定」の版の開始月は、暦の改定日（偶数年 6 月）の月と一致する", () => {
    for (const rev of REVISIONS.filter((r) => r.kind === "改定")) {
      const latest = latestRevision(calendar as Calendar, `${rev.effectiveFrom}-15T00:00:00+09:00`);
      expect(latest.slice(0, 7), rev.id).toBe(rev.effectiveFrom);
      expect(Number(rev.effectiveFrom.slice(0, 4)) % 2).toBe(0);
    }
  });
  it("どの版でも、点数表の値は EM の採用値（source が EM）。点数未収載は、所定点数の割合で決まる注8 の減算（C〜I に回した区分。L-92）だけ", () => {
    for (const rev of REVISIONS)
      for (const [k, d] of Object.entries(rev.points)) expect([k, d.source, typeof d.points]).toEqual(k === "C002_N8_GENSAN" ? [k, "未収載", "object"] : [k, "EM", "number"]);
    for (const rev of REVISIONS) expect(rev.consts.deferred).toContain("C002_N8_GENSAN");
  });
  it("ルールは R01〜R18 の 18 本", () => {
    expect(rulesOf("2026-10").map((r) => r.id)).toEqual(Array.from({ length: 18 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`));
  });
});
