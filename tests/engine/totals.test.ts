// design.md §7 #2：K1・K2・K3・K4・K7 の合計（evidence-master §5-2）、情報不足、取り忘れ
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { ClaimContext } from "../../src/engine/types";
import { makeCtx } from "../lifecycle/helpers";
import { month } from "../helpers/period";
import { fakeRevision } from "./fake-revisions";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const K1 = loadCase("K1");
const K2 = loadCase("K2");
const K4 = loadCase("K4");
const unknown = { known: false } as const;
const noNote16 = (c: ClaimContext): ClaimContext => ({ ...c, facility: { ...c.facility, note16Met: unknown } });

/** evidence-master §5-2 の合計（2026年10月診療分）。K5・K6 は EM が合計を決めていないので比べない */
const EM_TOTALS: [string, number][] = [
  ["K1", 14806],
  ["K2", 6372],
  ["K3", 16260],
  ["K4", 4540],
  ["K7", 4972],
];

describe("合計", () => {
  it.each(EM_TOTALS)("%s は %i 点で指摘なし", (name, total) => {
    // K4 は要介護度が未入力の症例なので、要介護 2 を入れてから比べる
    const c = name === "K4" ? withFact(K4, "careLevel", { known: true, value: 2 }) : loadCase(name);
    const r = evaluate(c);
    expect(r.total).toBe(total);
    expect(r.findings).toEqual([]);
    expect(r.revisionId).toBe("r2026");
  });
  it("K5・K6 は EM の内訳の行の小計と一致する（合計は EM が未確定・書かないとしている）", () => {
    expect(evaluate(loadCase("K5")).total).toBe(10175);
    expect(evaluate(loadCase("K6")).total).toBe(274);
    expect(evaluate(loadCase("K5")).findings).toEqual([]);
    expect(evaluate(loadCase("K6")).findings).toEqual([]);
  });
  it("点数未収載の区分があると total は null（同梱の版に未収載の区分はないので、作り物の版で確かめる）", () => {
    const rev = fakeRevision({ id: "fake-null", effectiveFrom: "2030-01", effectiveUntil: "2030-12" });
    rev.points.X9 = { name: "点数未収載の区分", no: "X9", points: null, source: "未収載" };
    const r = evaluate({ ...makeCtx({ yearMonth: "2030-06" }), lines: [{ kubun: "X1", count: 1, dates: [] }, { kubun: "X9", count: 1, dates: [] }] }, [rev]);
    expect(r.total).toBeNull();
    expect(r.byLine).toEqual([{ kubun: "X1", points: 10 }, { kubun: "X9", points: null }]);
  });
  it("指摘があっても合計は渡された行の和のまま", () => {
    const r = evaluate(withLines(K1, line("C101_2I")));
    expect(r.total).toBe(14806 + 650);
    expect(r.findings.length).toBeGreaterThan(0);
  });
  it("同じ行でも、2027年6月診療分は値の変更の版で合計が変わる（ベースアップ評価料と物価対応料だけ）", () => {
    const later = evaluate({ ...K1, yearMonth: "2027-06" });
    expect(later.revisionId).toBe("r2027-06");
    // 訪問診療時イ 79→158、物価対応料 訪問診療時 3→6 が 2 回ずつ
    expect(later.total).toBe(14806 + (158 - 79) * 2 + (6 - 3) * 2);
  });
});

describe("情報不足（三値の事実と施設の設定）", () => {
  it("K1 の table8_2 を不明にすると、それを使う R02 が情報不足（宛先は医師）。区分が未定の間、R01・R03 は出ない", () => {
    const r = evaluate(withFact(K1, "table8_2", unknown));
    expect(r.findings).toEqual([expect.objectContaining({ ruleId: "R02", kind: "情報不足", missing: { target: "doctor", field: "table8_2" } })]);
  });
  it("K1 は重症区分（2イ）なので、要介護度や注16 が不明でも情報不足は出ない（答えで結果が変わらないことは聞かない）", () => {
    expect(evaluate(withFact(K1, "careLevel", unknown)).findings).toEqual([]);
    expect(evaluate(noNote16(K1)).findings).toEqual([]);
  });
  it("K2 の注16 を不明にすると R01 の情報不足（宛先は医療事務、field は facility.note16Met）が 1 件", () => {
    expect(evaluate(noNote16(K2)).findings).toEqual([expect.objectContaining({ ruleId: "R01", kind: "情報不足", missing: { target: "clerk", field: "facility.note16Met" } })]);
  });
  it("K2 の要介護度を不明にすると R03 の情報不足（宛先は医療事務）が 1 件", () => {
    expect(evaluate(withFact(K2, "careLevel", unknown)).findings).toEqual([expect.objectContaining({ ruleId: "R03", kind: "情報不足", missing: { target: "clerk", field: "careLevel" } })]);
  });
  it("K4 は要介護度が未入力で、医療事務あての情報不足が 1 件。要介護 2 を入れると包括的支援加算は対象外で指摘なし（2026-11-06 ユーザー判断）", () => {
    expect(evaluate(K4).findings.map((f) => [f.ruleId, f.kind, f.missing])).toEqual([["R03", "情報不足", { target: "clerk", field: "careLevel" }]]);
    expect(evaluate(withFact(K4, "careLevel", { known: true, value: 2 })).findings).toEqual([]);
  });
  it("K2 の居住の場所を不明にすると R16 の情報不足（宛先は医療事務）（聞くのは住まいの種別。design.md §18-2 C-494）", () => {
    expect(evaluate(withFact(K2, "residence", unknown)).findings).toEqual([expect.objectContaining({ ruleId: "R16", kind: "情報不足", missing: { target: "clerk", field: "residenceType" } })]);
  });
});

describe("取り忘れ（K2）", () => {
  it("包括的支援加算と在宅移行早期加算を外すと R03・R14 の取り忘れが 1 件ずつ", () => {
    const r = evaluate(without(K2, "C002_N10_HOKATSU", "C002_N4_IKOU"));
    expect(r.findings.map((f) => `${f.ruleId}:${f.kind}`).sort()).toEqual(["R03:取り忘れ", "R14:取り忘れ"]);
    expect(r.total).toBe(6372 - 250);
  });
  it("算定開始から 4 か月目なら在宅移行早期加算は要件不足", () => {
    const late = { ...K2, events: K2.events.map((e) => (e.type === "kanriStart" ? { ...e, month: month(-3) } : e)) };
    expect(evaluate(late).findings.map((f) => `${f.ruleId}:${f.kind}`)).toEqual(["R14:要件不足"]);
  });
  it("届出に依存する加算（ベースアップ評価料・物価対応料・DX 加算）の付け忘れは検出しない", () => {
    expect(evaluate(without(K2, "O001_3I", "O100_1HA", "C001_N13_DX")).findings).toEqual([]);
  });
});

describe("K3 の要介護度（2026-11-06 ユーザー判断）", () => {
  it("K3 は要介護3。重症区分なので包括的支援加算は付かず、指摘なし", () => {
    expect(evaluate(loadCase("K3")).findings).toEqual([]);
  });
});
