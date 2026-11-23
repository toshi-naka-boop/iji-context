// 段 17h（design.md §15-4・§15-10）：注14 の申告 note14 と判定。R18 の注14 の次元（use_note14_reduced・note14_conflict・情報不足）、
// 版の減の行と note14Pairs（E-10）、D03 の減の行、R19 と重ねたとき（C-324・C-332）、注8 と重ねた減の行（X-171）、原請求との食い違い（X-172・C-330・C-333）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { compareRevisions } from "../../src/engine/compare";
import { derivedKubun, deriveLines, manualLinesOf, type DeriveInput, type DeriveResult } from "../../src/engine/derive";
import { claimMultiBandOf, claimNote14SideOf, kanriBandOf, kanriKubunOf, kubunFamily, reducedOf } from "../../src/engine/predicates";
import { resolveRevision } from "../../src/engine/revisions";
import { r2024 } from "../../src/engine/revisions/r2024";
import type { KanriFamily } from "../../src/engine/revisions/types";
import { NOTE14_BANDS, type BuildingBand, type ClaimContext, type Facility, type FacilityGrade, type Finding } from "../../src/engine/types";
import { deferredNote } from "../../src/generic/scope";
import { FINDING_TEXT, findingText, pendingText } from "../../src/messages";
import { YM } from "../helpers/period";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const REV = resolveRevision(YM);
const C = REV.consts;
const GRADES: FacilityGrade[] = ["1B", "1N", "2", "3"];
const FAMILIES: KanriFamily[] = ["在医総管", "施設総管"];
const K2 = loadCase("K2");
const K2_PLAIN = without(K2, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU");
const KANRI_DATE = K2.lines.find((l) => l.kubun === "C002_2RO1")!.dates;

const gradeFacility = (f: Facility, g: FacilityGrade): Facility => ({ ...f, grade: { known: true, value: g }, zaishishin: g !== "3", kyokagata: g === "1B" || g === "1N", hasBeds: g === "1B" });
const withResidence = (c: ClaimContext, family: KanriFamily): ClaimContext => withFact(c, "residence", { known: true, value: family === "在医総管" ? "居宅" : "施設入居等" });
type N14 = "通常" | "減算" | null;
/** building「ある」、患者の人数の区分 band（null は分からない）、注14 の申告 n14 */
const setup = (c: ClaimContext, band: BuildingBand | null, n14: N14, g: FacilityGrade = "2"): ClaimContext => ({
  ...c,
  facility: { ...gradeFacility(c.facility, g), building: { known: true, value: "some" }, note14: n14 === null ? { known: false } : { known: true, value: n14 } },
  facts: { ...c.facts, buildingBand: band ? { known: true, value: band } : { known: false } },
});
const claimWith = (kubun: string, band: BuildingBand | null, n14: N14, g: FacilityGrade = "2") => setup(withLines(K2_PLAIN, line(kubun, 1, KANRI_DATE)), band, n14, g);
const of = (c: ClaimContext, ids: string[]) => evaluate(c).findings.filter((f) => ids.includes(f.ruleId));
const keys = (fs: Finding[]) => fs.map((f) => (f.kind === "情報不足" ? `${f.messageKey}:${f.missing?.field}` : f.messageKey)).sort();
const inputOf = (c: ClaimContext, over: Partial<DeriveInput> = {}): DeriveInput => ({ yearMonth: c.yearMonth, facility: c.facility, facts: c.facts, events: c.events, history: c.history, manual: manualLinesOf(c.lines, REV), choices: {}, ...over });
const kanriOfResult = (r: DeriveResult) => r.lines.map((l) => l.kubun).filter((k) => kanriBandOf(C, k) !== undefined);

const RO3 = "C002_2RO3";
const RO3_N14 = "C002_2RO3_N14";

describe("版の減の行と note14Pairs（E-10）", () => {
  it("減の行 90 区分が点数表・コードの表にあり、組の通常の区分と族・種別・区分・人数の区分が同じ。derivedKubun・kubunFamily に入る", () => {
    const pairs = Object.entries(C.kanri.note14Pairs!);
    expect(pairs).toHaveLength(90);
    const fam = kubunFamily(C);
    for (const [red, normal] of pairs) {
      const a = C.kanri.rows.find((r) => r.kubun === red)!;
      const b = C.kanri.rows.find((r) => r.kubun === normal)!;
      expect([a.family, a.grade, a.tier, a.band], red).toEqual([b.family, b.grade, b.tier, b.band]);
      expect(NOTE14_BANDS).toContain(a.band);
      expect(Object.hasOwn(REV.points, red) && Object.hasOwn(REV.codes, red), red).toBe(true);
      expect(derivedKubun(C)).toContain(red);
      expect(fam[red]).toBe(fam[normal]);
    }
    // 在支診以外では、通常の区分 → 減の行が 2 つ（注14 だけ・注8 と重ねた行）。ほかの種別は 1 つ
    expect(reducedOf(C, "C002_3RO3").sort()).toEqual(["C002_3RO3_N14", "C002_3RO3_N8N14"]);
    expect(reducedOf(C, RO3)).toEqual([RO3_N14]);
  });
});

describe("R18 の注14 の次元", () => {
  it("減算の申告で 10 人以上の区分の通常の行に use_note14_reduced（組の減の行の名称を添える）", () => {
    const fs = of(claimWith(RO3, "10-19", "減算"), ["R18"]);
    expect(keys(fs)).toEqual(["R18.use_note14_reduced"]);
    expect(fs[0].params?.fix).toBe(RO3_N14);
    expect(findingText(fs[0])).toContain(REV.points[RO3_N14].name);
  });
  it("通常の申告で減の行：区分誤りを出さず、情報不足 R18.note14_conflict（申告の画面への案内つき）", () => {
    const fs = of(claimWith(RO3_N14, "10-19", "通常"), ["R18"]);
    expect(keys(fs)).toEqual(["R18.note14_conflict:facility.note14"]);
    expect(findingText(fs[0])).toContain("申告（10 人以上の区分を通常の点数で算定）と請求が食い違っています。申告を確かめてください");
    expect(findingText(fs[0])).toContain("施設の申告の画面");
    expect(evaluate(claimWith(RO3_N14, "10-19", "通常")).findings.some((f) => f.kind === "区分誤り")).toBe(false);
  });
  it("分からない申告では 10 人以上の区分の行（通常・減とも）にだけ情報不足。1 人・2〜9 人の区分の行には何も出ない", () => {
    for (const k of [RO3, RO3_N14]) expect(keys(of(claimWith(k, "10-19", null), ["R18"])), k).toEqual(["R18.missing_fact:facility.note14"]);
    for (const [k, b] of [["C002_2RO1", "1"], ["C002_2RO2", "2-9"]] as const) expect(of(claimWith(k, b, null), ["R18"]), k).toEqual([]);
  });
  it("R01・R02・R16 は注14 の次元で指摘を出さない（減の行でも通常の行と同じ）", () => {
    for (const [normal, red] of Object.entries(C.kanri.note14Pairs!).map(([r, n]) => [n, r])) {
      const row = C.kanri.rows.find((r) => r.kubun === normal)!;
      const a = keys(of(withResidence(claimWith(normal, row.band!, "通常", row.grade), row.family), ["R01", "R02", "R16"])).map((k) => k.replace(/:.*$/, ""));
      const b = keys(of(withResidence(claimWith(red, row.band!, "通常", row.grade), row.family), ["R01", "R02", "R16"])).map((k) => k.replace(/:.*$/, ""));
      expect(b, red).toEqual(a);
    }
  });
  it("X-171：種別 3 で減算・10 人以上の通常の行 → 注14 だけの減の行と注8 と重ねた減の行の両方を名指し。種別 2 では 1 つ", () => {
    const three = of(claimWith("C002_3RO3", "10-19", "減算", "3"), ["R18"]);
    expect(keys(three)).toEqual(["R18.use_note14_reduced"]);
    const text = findingText(three[0]);
    for (const k of ["C002_3RO3_N14", "C002_3RO3_N8N14"]) expect(text).toContain(REV.points[k].name);
    expect(text).toContain("注8 の減算に当たるかで決まります。注8 は見ていません");
    expect(of(claimWith(RO3, "10-19", "減算"), ["R18"])[0].params?.fix).toBe(RO3_N14);
  });
});

describe("R19 と重ねたとき（round-57 C-324・round-58 C-332）", () => {
  const r1819 = (c: ClaimContext) => keys(of(c, ["R18", "R19"]));
  it("C-324 (1)：減算・人数 2〜9 人・請求が 10 人以上の通常の行 → R19 use_band が 2〜9 人の区分を名指し、R18 の注14 の次元は出ない", () => {
    const c = claimWith(RO3, "2-9", "減算");
    expect(r1819(c)).toEqual(["R19.use_band"]);
    expect(of(c, ["R19"])[0].params?.fix).toBe("C002_2RO2");
  });
  it("C-324 (2)：人数 10〜19 人・請求が 2〜9 人の区分の行 → R19 の直し先は減算なら減の行、通常なら通常の行、分からないなら名称なし", () => {
    expect(of(claimWith("C002_2RO2", "10-19", "減算"), ["R19"])[0].params?.fix).toBe(RO3_N14);
    expect(of(claimWith("C002_2RO2", "10-19", "通常"), ["R19"])[0].params?.fix).toBe(RO3);
    const u = of(claimWith("C002_2RO2", "10-19", null), ["R19"]);
    expect(u[0].params?.fix).toBeUndefined();
    expect(findingText(u[0])).toContain("注14 の申告によって通常の行か減の行のどちらかです");
    // C-332 (a)：分からない申告で、請求は 2〜9 人の行 → R18 は何も出さない
    expect(of(claimWith("C002_2RO2", "10-19", null), ["R18"])).toEqual([]);
  });
  it("C-324 (3)：減算・人数 20〜49 人・請求が 10〜19 人の通常の行 → R19 が 20 人以上の減の行を名指しし、R18 use_note14_reduced は重なりの規則で出ない", () => {
    const c = claimWith(RO3, "20-49", "減算");
    expect(r1819(c)).toEqual(["R19.use_band"]);
    expect(of(c, ["R19"])[0].params?.fix).toBe("C002_2RO4_N14");
  });
  it("C-332 (b)：減算・請求が 10 人以上の通常の行・人数が分からない → R19 は情報不足、R18 は use_note14_reduced", () => {
    expect(r1819(claimWith(RO3, null, "減算"))).toEqual(["R18.use_note14_reduced", "R19.missing_fact:buildingBand"]);
  });
  it("C-332 (c)：通常・請求が 10〜19 人の減の行・人数 20 人以上 → R19 が 20 人以上の減の行を名指しし、R18 note14_conflict も出る", () => {
    const c = claimWith(RO3_N14, "20-49", "通常");
    expect(r1819(c)).toEqual(["R18.note14_conflict:facility.note14", "R19.use_band"]);
    expect(of(c, ["R19"])[0].params?.fix).toBe("C002_2RO4_N14");
  });
  it("R18 の recordFindings は空（行と申告だけで決まる）", () => {
    expect(REV.rules.find((r) => r.id === "R18")!.recordFindings).toEqual([]);
  });
});

describe("D03 の減の行", () => {
  const derive = (c: ClaimContext, over: Partial<DeriveInput> = {}) => deriveLines(inputOf(c, over), REV);
  it("10 人以上の区分の患者：減算なら減の行、通常なら通常の行、分からないなら保留（facility.note14）。導出した行を検証に通して区分誤り・取り忘れが 0 件（人数の区分×種別×族×注14 の 2 値）", () => {
    for (const g of GRADES)
      for (const f of FAMILIES)
        for (const b of NOTE14_BANDS)
          for (const n of ["通常", "減算"] as const) {
            const c = withResidence(setup(K2, b, n, g), f);
            const r = derive(c);
            const normal = kanriKubunOf(C, f, g, "ロ", b)!;
            const reds = reducedOf(C, normal);
            if (n === "減算" && reds.length !== 1) {
              // X-171：在支診以外では減の行を 1 つに決められないので立てない（理由つきの保留）
              expect(r.pending, `${g} ${f} ${b} ${n}`).toEqual([expect.objectContaining({ kind: "事実不足", need: "facility.note14", reason: "note8" })]);
              expect(kanriOfResult(r)).toEqual([]);
              expect(pendingText(r.pending[0] as never, (d) => d)).toBe("注8 の減算に当たるかを見ていないので、減の行を 1 つに決められません");
              continue;
            }
            expect(r.pending, `${g} ${f} ${b} ${n}`).toEqual([]);
            expect(kanriOfResult(r), `${g} ${f} ${b} ${n}`).toEqual([n === "減算" ? reds[0] : normal]);
            const fs = evaluate({ ...c, lines: r.lines }).findings.filter((x) => x.kind === "区分誤り" || x.kind === "取り忘れ");
            expect(fs, `${g} ${f} ${b} ${n}`).toEqual([]);
          }
    const u = derive(setup(K2, "10-19", null));
    expect(u.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "facility.note14", target: "clerk" })]);
    expect(kanriOfResult(u)).toEqual([]);
  });

  it("X-172：通常の申告で、原請求の 10 人以上の管理料が減の行 → 通常の行を立てず保留（reason: note14_conflict。文は R18.note14_conflict と同じ）。減算に直すと減の行が立つ。減算で原請求が通常の行なら減の行が立つ", () => {
    const orig = withLines(K2_PLAIN, line(RO3_N14, 1, KANRI_DATE));
    const side = claimNote14SideOf(orig.lines, C);
    expect(side).toBe("減");
    const r = derive(setup(K2, "10-19", "通常"), { claimNote14Side: side });
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "facility.note14", reason: "note14_conflict" })]);
    expect(kanriOfResult(r)).toEqual([]);
    expect(pendingText(r.pending[0] as never, (d) => d)).toContain(findingText({ ruleId: "R18", kind: "情報不足", lineRefs: [], missing: { target: "clerk", field: "facility.note14" }, messageKey: "R18.note14_conflict", reference: "" }).split("。")[0]);
    expect(kanriOfResult(derive(setup(K2, "10-19", "減算"), { claimNote14Side: side }))).toEqual([RO3_N14]);
    expect(kanriOfResult(derive(setup(K2, "10-19", "減算"), { claimNote14Side: "通常" }))).toEqual([RO3_N14]);
  });

  it("X-200：building「ない」の申告でも、原請求に 2 人以上・10 人以上の区分の行（通常・減とも）があれば 1 人の区分を立てず保留（R19.declaration_conflict と同じ文）。減の行で通常の申告なら note14_conflict も残る", () => {
    const none = (c: ClaimContext, n14: N14): ClaimContext => ({ ...c, facility: { ...gradeFacility(c.facility, "2"), building: { known: true, value: "none" }, note14: n14 === null ? { known: false } : { known: true, value: n14 } } });
    const reasonsOf = (r: DeriveResult) => r.pending.map((p) => (p.kind === "事実不足" ? `${p.need}:${p.reason ?? ""}` : p.kind)).sort();
    // 指摘の入力：原請求が C002_2RO3_N14・申告 building=none・note14=通常
    const orig = withLines(K2_PLAIN, line(RO3_N14, 1, KANRI_DATE));
    const r = derive(none(K2, "通常"), { claimNote14Side: claimNote14SideOf(orig.lines, C), claimMultiBand: claimMultiBandOf(orig.lines, C) });
    expect(kanriOfResult(r)).toEqual([]);
    expect(reasonsOf(r)).toEqual(["facility.building:declaration_conflict", "facility.note14:note14_conflict"]);
    const texts = r.pending.map((p) => pendingText(p as never, (d) => d));
    expect(texts.some((t) => t.startsWith(FINDING_TEXT["R19.declaration_conflict"]))).toBe(true);
    expect(texts.some((t) => t.startsWith(FINDING_TEXT["R18.note14_conflict"]))).toBe(true);
    // 2〜9 人・10 人以上の通常の行でも保留（1 人の区分を立てない）
    for (const k of ["C002_2RO2", RO3]) {
      const o = withLines(K2_PLAIN, line(k, 1, KANRI_DATE));
      expect(claimMultiBandOf(o.lines, C), k).toBe(true);
      const x = derive(none(K2, "通常"), { claimNote14Side: claimNote14SideOf(o.lines, C), claimMultiBand: true });
      expect(kanriOfResult(x), k).toEqual([]);
      expect(reasonsOf(x), k).toEqual(["facility.building:declaration_conflict"]);
    }
    // 原請求が 1 人の区分なら今までどおり 1 人の区分を立てる
    const one = withLines(K2_PLAIN, line("C002_2RO1", 1, KANRI_DATE));
    expect(claimMultiBandOf(one.lines, C)).toBe(false);
    expect(kanriOfResult(derive(none(K2, "通常"), { claimMultiBand: false }))).toEqual(["C002_2RO1"]);
  });

  it("C-333：原請求の注14 の側は、日で絞る前の請求の全部の行から求める（算定日が後の減の行も「減」）。比べる版に減の行がない（令和6年度の版）ときは「なし」", () => {
    const later = [line("C001_1I", 1, [KANRI_DATE[0]]), line(RO3_N14, 1, ["2026-10-20"])];
    expect(claimNote14SideOf(later, C)).toBe("減");
    expect(claimNote14SideOf(later, r2024.consts)).toBe("なし");
    expect(claimNote14SideOf([line(RO3, 1, KANRI_DATE)], C)).toBe("通常");
    expect(claimNote14SideOf([line("C002_2RO2", 1, KANRI_DATE)], C)).toBe("なし");
    // 改定の比較（compareOf）でも同じ請求で通常の行が立たない
    const c = setup(K2, "10-19", "通常");
    const cmp = compareRevisions(inputOf(c, { claimNote14Side: "減" }), REV, REV);
    expect(cmp.rows.flatMap((r) => (r.to ? [r.to.kubun] : []))).not.toContain(RO3);
    expect(cmp.pending.to).toEqual([expect.objectContaining({ reason: "note14_conflict" })]);
  });
});

describe("G10・L-92 との関係", () => {
  it("注8 と重ねた減の行は、L-92 の「見ていません」に数えられる（注8 の次元は見ない）", () => {
    expect(deferredNote([line("C002_3RO3_N8N14", 1, KANRI_DATE)], REV)).toContain("：1 行");
    expect(deferredNote([line(RO3_N14, 1, KANRI_DATE)], REV)).toBeNull();
  });
});

describe("K1〜K11（デモの building「ない」）", () => {
  it("note14 の情報不足が出ず、R18・R19 の指摘も変わらない", () => {
    for (const n of ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10", "K11"]) {
      const fs = evaluate(loadCase(n)).findings;
      expect(fs.filter((f) => f.missing?.field === "facility.note14"), n).toEqual([]);
      expect(fs.filter((f) => f.messageKey.startsWith("R18.use_note14") || f.messageKey === "R18.note14_conflict"), n).toEqual([]);
    }
  });
});
