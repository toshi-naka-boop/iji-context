// design.md §7 #2：K1・K2 の合計、情報不足、取り忘れ
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const K1 = loadCase("K1");
const K2 = loadCase("K2");

describe("合計", () => {
  it("K1 は 14,693 点で指摘なし", () => {
    const r = evaluate(K1);
    expect(r.total).toBe(14693);
    expect(r.findings).toEqual([]);
  });
  it("K2 は 6,193 点で指摘なし", () => {
    const r = evaluate(K2);
    expect(r.total).toBe(6193);
    expect(r.findings).toEqual([]);
  });
  it("点数未収載の区分があると total は null", () => {
    expect(evaluate(withLines(K1, line("B000"))).total).toBeNull();
  });
  it("指摘があっても合計は渡された行の和のまま", () => {
    const r = evaluate(withLines(K1, line("C101_2I")));
    expect(r.total).toBe(14693 + 650);
  });
});

describe("情報不足（三値の事実）", () => {
  it("K1 の table8_2 を不明にすると、それを使う R02・R03 が情報不足（宛先は医師）", () => {
    const r = evaluate(withFact(K1, "table8_2", { known: false }));
    const missing = r.findings.filter((f) => f.kind === "情報不足");
    expect(missing.map((f) => f.ruleId).sort()).toEqual(["R02", "R03"]);
    expect(missing.every((f) => f.missing?.field === "table8_2" && f.missing.target === "doctor")).toBe(true);
    expect(r.findings.filter((f) => f.kind !== "情報不足")).toEqual([]);
  });
  it("K1 の careLevel を不明にすると R03 が情報不足（宛先は医療事務）", () => {
    const r = evaluate(withFact(K1, "careLevel", { known: false }));
    expect(r.findings).toEqual([expect.objectContaining({ ruleId: "R03", kind: "情報不足", missing: { target: "clerk", field: "careLevel" } })]);
  });
});

describe("取り忘れ（K2）", () => {
  it("包括的支援加算と在宅移行早期加算を外すと R03・R14 の取り忘れが 1 件ずつ", () => {
    const r = evaluate(without(K2, "C002_N10_HOKATSU", "C002_N4_IKOU"));
    expect(r.findings.map((f) => `${f.ruleId}:${f.kind}`).sort()).toEqual(["R03:取り忘れ", "R14:取り忘れ"]);
    expect(r.total).toBe(6193 - 250);
  });
  it("算定開始から 4 か月目なら在宅移行早期加算は要件不足", () => {
    const late = { ...K2, events: K2.events.map((e) => (e.type === "kanriStart" ? { ...e, month: "2024-12" } : e)) };
    expect(evaluate(late).findings.map((f) => `${f.ruleId}:${f.kind}`)).toEqual(["R14:要件不足"]);
  });
});

describe("K3・K4 の要介護度（2026-11-06 ユーザー判断）", () => {
  it("K3 は要介護3。重症区分なので包括的支援加算は付かず、指摘なし", () => {
    expect(evaluate(loadCase("K3")).findings).toEqual([]);
  });
  it("K4 は要介護度が未入力で、医療事務あての情報不足が 1 件。要介護2 を入れると包括的支援加算は対象外で指摘なし", () => {
    const k4 = loadCase("K4");
    expect(evaluate(k4).findings.map((f) => [f.ruleId, f.kind, f.missing])).toEqual([["R03", "情報不足", { target: "clerk", field: "careLevel" }]]);
    expect(evaluate(withFact(k4, "careLevel", { known: true, value: 2 })).findings).toEqual([]);
  });
});
