// 段 17f（design.md §15-4・§15-10）：単一建物の人数の区分（EM R8-94〜R8-192）。版の人数の区分、施設の申告 building（C-242）、
// buildingBandOf、R19、D03 の人数、みなしのコメント（V-3）、人数の読みと入力の案内（V-4）、減算中の施設の請求（17h までの扱い）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { deriveLines, manualLinesOf, type DeriveInput, type DeriveResult } from "../../src/engine/derive";
import { buildingBandOf, kanriBandOf, kanriKubunOf } from "../../src/engine/predicates";
import { resolveRevision } from "../../src/engine/revisions";
import type { KanriFamily } from "../../src/engine/revisions/types";
import { minashiOneLines } from "../../src/engine/rules/r19";
import { BUILDING_BANDS, NOTE14_BANDS, type BuildingBand, type ClaimContext, type Comment, type Facility, type FacilityGrade, type Finding } from "../../src/engine/types";
import { BUILDING_BAND_GUIDE, findingText } from "../../src/messages";
import { buildingBandOfRows, validatePatientFact } from "../../src/patient/facts";
import { factBody } from "../../src/server/schemas/patients";
import { YM } from "../helpers/period";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const REV = resolveRevision(YM);
const C = REV.consts;
const GRADES: FacilityGrade[] = ["1B", "1N", "2", "3"];
const FAMILIES: KanriFamily[] = ["在医総管", "施設総管"];

const K2 = loadCase("K2");
/** K2（訪問診療料 2 回・重症でない。期待される区分は ロ）から管理料と管理料に付く加算を外した請求 */
const K2_PLAIN = without(K2, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU");
const KANRI_DATE = K2.lines.find((l) => l.kubun === "C002_2RO1")!.dates;

const gradeFacility = (f: Facility, g: FacilityGrade): Facility => ({ ...f, grade: { known: true, value: g }, zaishishin: g !== "3", kyokagata: g === "1B" || g === "1N", hasBeds: g === "1B" });
const withResidence = (c: ClaimContext, family: KanriFamily): ClaimContext => withFact(c, "residence", { known: true, value: family === "在医総管" ? "居宅" : "施設入居等" });
/** 施設の申告 building と患者ごとの人数の区分 */
const withBuilding = (c: ClaimContext, building: "none" | "some" | null, band?: BuildingBand | null, basis?: "declaration", note14: "通常" | "減算" | null = "通常"): ClaimContext => ({
  ...c,
  facility: { ...c.facility, building: building === null ? { known: false } : { known: true, value: building }, note14: note14 === null ? { known: false } : { known: true, value: note14 } },
  facts: { ...c.facts, buildingBand: band ? { known: true, value: band } : { known: false } },
  ...(basis ? { facilityBasis: { ...c.facilityBasis, building: basis } } : {}),
});
const r19 = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R19");
const keys = (fs: Finding[]) => fs.map((f) => (f.kind === "情報不足" ? `${f.messageKey}:${f.missing?.field}` : f.messageKey)).sort();
const inputOf = (c: ClaimContext, over: Partial<DeriveInput> = {}): DeriveInput => ({ yearMonth: c.yearMonth, facility: c.facility, facts: c.facts, events: c.events, history: c.history, manual: manualLinesOf(c.lines, REV), choices: {}, ...over });
const derive = (c: ClaimContext): DeriveResult => deriveLines(inputOf(c), REV);
const kanriOfResult = (r: DeriveResult) => r.lines.map((l) => l.kubun).filter((k) => kanriBandOf(C, k) !== undefined);
const commentOf = (code: string, on: string[]): Comment => ({ code, text: "", raw: "", on });

describe("版の人数の区分（EM R8-95〜R8-190）", () => {
  it("族×種別×区分のどの組にも、5 つの人数の区分の行がある（1 人は今の行）", () => {
    for (const f of FAMILIES) for (const g of GRADES) for (const t of ["イ", "ロ", "ニ"] as const) for (const b of BUILDING_BANDS) expect(kanriKubunOf(C, f, g, t, b), `${f} ${g} ${t} ${b}`).toBeDefined();
    expect(C.kanri.rows.filter((r) => r.band !== undefined && r.note14 === undefined)).toHaveLength(96);
  });
});

describe("R19（人数の区分ごと×族）", () => {
  // 管理料の行の人数の区分が、患者の人数の区分と違えば use_band（直し先は同じ族・種別・区分の、患者の人数の区分の行。注14 の申告は「通常」）。同じなら言わない
  for (const f of FAMILIES)
    for (const lineBand of BUILDING_BANDS)
      it(`${f}・行の人数 ${lineBand}`, () => {
        for (const band of BUILDING_BANDS) {
          const kubun = kanriKubunOf(C, f, "2", "ロ", lineBand)!;
          const c = withBuilding(withLines(withResidence(K2_PLAIN, f), line(kubun, 1, KANRI_DATE)), "some", band);
          const fs = r19(c);
          if (band === lineBand) expect(fs, `${band}`).toEqual([]);
          else {
            expect(keys(fs), band).toEqual(["R19.use_band"]);
            expect(fs[0].params?.fix).toBe(kanriKubunOf(C, f, "2", "ロ", band));
            expect(fs[0].params?.fixName).toBe(REV.points[kanriKubunOf(C, f, "2", "ロ", band)!].name);
          }
        }
      });

  it("building が「ない」の申告では、患者ごとの値がなくても全患者が 1 人の区分：1 人の区分の管理料は R19 が通り、D03 が保留しない", () => {
    const c = withBuilding(K2, "none", null, "declaration");
    expect(buildingBandOf(c)).toEqual({ known: true, value: "1", byDeclaration: true });
    expect(r19(c)).toEqual([]);
    const r = derive(c);
    expect(r.pending).toEqual([]);
    expect(kanriOfResult(r)).toEqual(["C002_2RO1"]);
  });

  it("building が「ない」の申告で 2 人以上の区分の行：use_band を出さず、申告と請求の食い違いの情報不足（施設の申告の画面への案内つき）", () => {
    for (const b of BUILDING_BANDS.filter((x) => x !== "1")) {
      const c = withBuilding(withLines(K2_PLAIN, line(kanriKubunOf(C, "在医総管", "2", "ロ", b)!, 1, KANRI_DATE)), "none", null, "declaration");
      const fs = r19(c);
      expect(keys(fs), b).toEqual(["R19.declaration_conflict:facility.building"]);
      expect(findingText(fs[0])).toContain("申告（2 人以上の建物はない）と請求が食い違っています。申告を確かめてください");
      expect(findingText(fs[0])).toContain("施設の申告の画面");
      expect(evaluate(c).findings.some((x) => x.messageKey === "R19.use_band")).toBe(false);
    }
  });

  it("building が「ある」で患者ごとの値が 2 人以上なのに 1 人の区分の行：今までどおり use_band（2 人以上の側）", () => {
    const c = withBuilding(K2, "some", "2-9");
    expect(keys(r19(c))).toEqual(["R19.use_band"]);
    expect(r19(c)[0].params?.fix).toBe("C002_2RO2");
  });

  it("building が「ある」「分からない」で患者ごとの値が効かない：管理料のどの行（1 人の区分を含む）でも情報不足（buildingBand）。「分からない」では施設の申告の画面への案内が先に出る", () => {
    for (const kubun of ["C002_2RO1", "C002_2RO2", "C002_2RO4"]) {
      const lines = withLines(K2_PLAIN, line(kubun, 1, KANRI_DATE));
      const some = r19(withBuilding(lines, "some", null));
      expect(keys(some), kubun).toEqual(["R19.missing_fact:buildingBand"]);
      expect(findingText(some[0])).not.toContain("施設の申告");
      const unknown = r19(withBuilding(lines, null, null));
      expect(keys(unknown), kubun).toEqual(["R19.missing_fact:buildingBand"]);
      expect(findingText(unknown[0]).indexOf("施設の申告")).toBe(0);
    }
    const d = derive(withBuilding(K2, "some", null));
    expect(d.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "buildingBand", target: "clerk" })]);
    expect(kanriOfResult(d)).toEqual([]);
  });

  it("R01・R02・R16・R18 は人数の次元で指摘を出さない（1 人の区分の行と同じ指摘。注14 の申告は「通常」）", () => {
    for (const g of GRADES)
      for (const f of FAMILIES)
        for (const tier of ["イ", "ロ", "ニ"] as const) {
          const one = withBuilding(withLines(withResidence({ ...K2_PLAIN, facility: gradeFacility(K2_PLAIN.facility, "2") }, f), line(kanriKubunOf(C, f, g, tier)!, 1, KANRI_DATE)), "some", "1");
          const base = keys(evaluate(one).findings.filter((x) => ["R01", "R02", "R16", "R18"].includes(x.ruleId))).map((k) => k.replace(/:.*$/, ""));
          for (const b of BUILDING_BANDS) {
            const c = withBuilding(withLines(withResidence({ ...K2_PLAIN, facility: gradeFacility(K2_PLAIN.facility, "2") }, f), line(kanriKubunOf(C, f, g, tier, b)!, 1, KANRI_DATE)), "some", b);
            const got = keys(evaluate(c).findings.filter((x) => ["R01", "R02", "R16", "R18"].includes(x.ruleId))).map((k) => k.replace(/:.*$/, ""));
            expect(got, `${g} ${f} ${tier} ${b}`).toEqual(base);
          }
        }
  });
});

describe("D03 の人数（buildingBand で区分を引く）", () => {
  it("導出した行を検証に通して区分誤り・取り忘れが 0 件（人数の区分〔10 人未満〕×種別×族。10 人以上は注14 の申告「通常」の通常の行。減算は tests/engine/note14.test.ts）。注14 が分からない 10 人以上は保留", () => {
    for (const g of GRADES)
      for (const f of FAMILIES)
        for (const b of BUILDING_BANDS) {
          const c = withBuilding(withResidence({ ...K2, facility: gradeFacility(K2.facility, g) }, f), "some", b);
          if (NOTE14_BANDS.includes(b)) {
            const held = derive(withBuilding(c, "some", b, undefined, null));
            expect(held.pending, `${g} ${f} ${b}`).toEqual([expect.objectContaining({ kind: "事実不足", need: "facility.note14", target: "clerk" })]);
            expect(kanriOfResult(held)).toEqual([]);
          }
          const r = derive(c);
          expect(r.pending, `${g} ${f} ${b}`).toEqual([]);
          expect(kanriOfResult(r), `${g} ${f} ${b}`).toEqual([kanriKubunOf(C, f, g, "ロ", b)]);
          const fs = evaluate({ ...c, lines: r.lines }).findings.filter((x) => x.kind === "区分誤り" || x.kind === "取り忘れ");
          expect(fs, `${g} ${f} ${b}`).toEqual([]);
        }
  });

  it("患者ごとの値は「いつの診療月から」つきで、次に変わるまでの月に効く（月ごとに入れ直さなくてよい）", () => {
    const rows = [
      { key: "buildingBand" as const, value: { band: "2-9" as const, fromMonth: "2026-08" } },
      { key: "buildingBand" as const, value: { band: "10-19" as const, fromMonth: "2026-12" } },
      // さかのぼって入れた行（有効月の順で選ぶ。入れた順は効かない）
      { key: "buildingBand" as const, value: { band: "1" as const, fromMonth: "2026-06" } },
    ];
    expect(buildingBandOfRows(rows, "2026-05")).toEqual({ known: false });
    expect(buildingBandOfRows(rows, "2026-07")).toEqual({ known: true, value: "1" });
    expect(buildingBandOfRows(rows, "2026-10")).toEqual({ known: true, value: "2-9" });
    expect(buildingBandOfRows(rows, "2026-11")).toEqual({ known: true, value: "2-9" });
    expect(buildingBandOfRows(rows, "2027-01")).toEqual({ known: true, value: "10-19" });
  });

  it("デモの症例（config の building「ない」）は、患者ごとの値なしで 1 人の区分になる", () => {
    for (const n of ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10", "K11"]) {
      const c = loadCase(n);
      expect(c.facts.buildingBand, n).toBeUndefined();
      expect(c.facility.building, n).toEqual({ known: true, value: "none" });
      expect(r19(c), n).toEqual([]);
    }
  });
});

describe("みなしのコメント（V-3。EM R8-192）", () => {
  const ICHI = withLines(K2_PLAIN, line("C002_2RO1", 1, KANRI_DATE));
  const withComments = (c: ClaimContext, ...cs: Comment[]): ClaimContext => ({ ...c, comments: cs, commentsKnown: true });
  it("戸数によるみなしが付いた在医総管の 1 人の区分の行：buildingBand が効かなくても R19 は何も出さず、点検の範囲に数える", () => {
    for (const code of ["820100095", "820100096"]) {
      const c = withComments(withBuilding(ICHI, "some", null), commentOf(code, ["C002_2RO1"]));
      expect(r19(c), code).toEqual([]);
      expect(minashiOneLines(c, C)).toEqual(["C002_2RO1"]);
      // 確かめた人数が 2 人以上でも、みなしの読みだけで点数の高い区分へ直さない
      expect(r19(withComments(withBuilding(ICHI, "some", "2-9"), commentOf(code, ["C002_2RO1"]))), code).toEqual([]);
    }
  });
  it("戸数によるみなしが 2 人以上の区分の行に付いた：情報不足（buildingBand）。use_band は出さない", () => {
    const c = withComments(withBuilding(withLines(K2_PLAIN, line("C002_2RO2", 1, KANRI_DATE)), "some", "1"), commentOf("820100095", ["C002_2RO2"]));
    expect(keys(r19(c))).toEqual(["R19.missing_fact:buildingBand"]);
  });
  it("ユニット数によるみなし：buildingBand が効けばそれと比べ（違えば use_band、同じなら言わない）、効かないときだけ情報不足", () => {
    const shi = withResidence(withLines(K2_PLAIN, line("C002-2_2RO2", 1, KANRI_DATE)), "施設総管");
    const unit = commentOf("820100094", ["C002-2_2RO2"]);
    expect(r19(withComments(withBuilding(shi, "some", "2-9"), unit))).toEqual([]);
    expect(keys(r19(withComments(withBuilding(shi, "some", "10-19"), unit)))).toEqual(["R19.use_band"]);
    expect(keys(r19(withComments(withBuilding(shi, "some", null), unit)))).toEqual(["R19.missing_fact:buildingBand"]);
  });
});

describe("人数の読みと入力の案内（V-4）", () => {
  it("患者ごとの人数の値に「月の途中で変わった」の入力がない（API の形にも欄がない）", () => {
    const ok = { fact: { key: "buildingBand", value: { band: "2-9", fromMonth: "2026-10" }, source: "カルテ", validUntil: null } };
    expect(factBody.safeParse(ok).success).toBe(true);
    expect(factBody.safeParse({ fact: { ...ok.fact, value: { ...ok.fact.value, midMonth: true } } }).success).toBe(false);
    expect(() => validatePatientFact({ key: "buildingBand", value: { band: "2-9", fromMonth: "" }, source: "カルテ", validUntil: null }, "2026-11-01T09:00:00+09:00")).toThrow(/いつの診療月から/);
  });
  it("入力の案内は、その月に算定する人の数・みなしを当てたあとの区分で、「読み（明文なし）」と出る", () => {
    expect(BUILDING_BAND_GUIDE).toContain("その月に、この建物で在医総管か施医総管を算定する人の数（月の途中で亡くなった人・入居した人も、その月に算定するなら数えます）");
    expect(BUILDING_BAND_GUIDE).toContain("みなしを当てたあとの、請求に使う区分");
    expect(BUILDING_BAND_GUIDE).toContain("読み〔明文なし〕");
    const f = r19(withBuilding(K2, "some", null))[0];
    expect(findingText(f)).toContain(BUILDING_BAND_GUIDE);
  });
});

describe("K1〜K7 は v28 と同じ（デモの building「ない」）", () => {
  it("R19 は何も言わず、ほかの指摘・合計は R19 を足す前と同じ（R19 を除いた評価と比べる）", () => {
    for (const n of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) {
      const c = loadCase(n);
      const a = evaluate(c);
      expect(a.findings.filter((f) => f.ruleId === "R19"), n).toEqual([]);
    }
  });
});
