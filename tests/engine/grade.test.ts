// 段 17d（design.md §15-4・§15-10）：施設の種別で分かれる区分（45 区分）、expectedKanri の種別、R18、R09・R10 の種別ごとの区分、
// 導出 D02・D03・D07・D12、derivedKubun・g11Owned・kubunFamily、「申告だけを根拠に点数の高い区分へ直さない」（C-251）、C〜I に回した区分の「見ていない」（L-92）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { derivedKubun, deriveLines, g11Owned, manualLinesOf, type DeriveInput, type DeriveResult } from "../../src/engine/derive";
import { gradeSlots, kanriKubun, kanriKubunOf, kubunFamily } from "../../src/engine/predicates";
import { resolveRevision } from "../../src/engine/revisions";
import type { KanriFamily, KanriTierKey, RevisionConsts } from "../../src/engine/revisions/types";
import { makeR01 } from "../../src/engine/rules/r01";
import { makeR18 } from "../../src/engine/rules/r18";
import type { ClaimContext, ClaimLine, Facility, FacilityGrade, Finding } from "../../src/engine/types";
import { deferredNote } from "../../src/generic/scope";
import { findingText } from "../../src/messages";
import { day, YM } from "../helpers/period";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const REV = resolveRevision(YM);
const C = REV.consts;
const GRADES: FacilityGrade[] = ["1B", "1N", "2", "3"];
const FAMILIES: KanriFamily[] = ["在医総管", "施設総管"];
const TIERS: KanriTierKey[] = ["イ", "ロ", "ニ"];
const unknown = { known: false } as const;
const yes = { known: true, value: true } as const;
const no = { known: true, value: false } as const;

/** 種別 g の施設（zaishishin なども種別に合わせる。申告から作るときと同じ形） */
const gradeFacility = (f: Facility, g: FacilityGrade | null): Facility => ({
  ...f,
  grade: g === null ? { known: false } : { known: true, value: g },
  zaishishin: g === null ? null : g !== "3",
  kyokagata: g === null ? null : g === "1B" || g === "1N",
  hasBeds: g === null ? null : g === "1B",
});
const withGrade = (c: ClaimContext, g: FacilityGrade | null, more: Partial<Facility> = {}): ClaimContext => ({ ...c, facility: { ...gradeFacility(c.facility, g), ...more } });
const withResidence = (c: ClaimContext, family: KanriFamily): ClaimContext => withFact(c, "residence", { known: true, value: family === "在医総管" ? "居宅" : "施設入居等" });
const keysOf = (fs: Finding[], rules: string[]) => fs.filter((f) => rules.includes(f.ruleId)).map((f) => (f.kind === "情報不足" ? `${f.ruleId}:情報不足:${f.missing?.field}` : f.messageKey)).sort();
const inputOf = (c: ClaimContext, over: Partial<DeriveInput> = {}): DeriveInput => ({
  yearMonth: c.yearMonth,
  facility: c.facility,
  facts: c.facts,
  events: c.events,
  history: c.history,
  manual: manualLinesOf(c.lines, REV),
  choices: (c as ClaimContext & { choices?: Record<string, string> }).choices ?? {},
  ...over,
});
const derive = (c: ClaimContext, over: Partial<DeriveInput> = {}): DeriveResult => deriveLines(inputOf(c, over), REV);
const kubunOf = (r: DeriveResult) => r.lines.map((l) => l.kubun);
const wrongOrMissed = (fs: Finding[]) => fs.filter((f) => f.kind === "区分誤り" || f.kind === "取り忘れ");

const K1 = loadCase("K1");
const K2 = loadCase("K2");
const K5 = loadCase("K5");
/** K2 から管理料に付く加算を外した請求（訪問診療料 2 回・重症でない。期待される区分は ロ） */
const K2_PLAIN = without(K2, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU");
const KANRI_DATE = K2.lines.find((l) => l.kubun === "C002_2RO1")!.dates;

/** 単一建物 1 人の区分の行（人数の次元は R19 の担当。tests/engine/building.test.ts） */
const ONE = C.kanri.rows.filter((r) => r.band === undefined && r.note14 === undefined);

describe("版の区分（EM §2-2 R8-49〜93・§2-8 の 45 行）", () => {
  // 単一建物 1 人の区分が 2×4×3 の 24 行。段 17f で人数の区分（2〜9・10〜19・20〜49・50 人以上）の 96 行（EM R8-95〜R8-190）を、段 17h で注14 の減の行の 90 行を足して 210 行
  it("族×種別×区分の表は 2×4×3 の 24 行（単一建物 1 人の区分。人数の区分と注14 の減の行を足して 210 行）で、どれも版の点数表とコードの表にある", () => {
    expect(ONE).toHaveLength(24);
    expect(C.kanri.rows).toHaveLength(210);
    for (const f of FAMILIES) for (const g of GRADES) for (const t of TIERS) expect(kanriKubunOf(C, f, g, t), `${f} ${g} ${t}`).toBeDefined();
    for (const k of kanriKubun(C)) expect(Object.hasOwn(REV.codes, k) && Object.hasOwn(REV.points, k), k).toBe(true);
  });
  it("在宅ターミナルケア加算・緊急往診加算は 4 種別の区分。D02・D12・R09・R10・R18 が同じ表を引く", () => {
    expect(C.terminal.terminal).toEqual({ "1B": "C001_N6_TERMINAL_1B", "1N": "C001_N6_TERMINAL_1N", "2": "C001_N6_TERMINAL", "3": "C001_N6_TERMINAL_3" });
    expect(C.oushin.kinkyu).toEqual({ "1B": "C000_N1_KINKYU_1B", "1N": "C000_N1_KINKYU_1N", "2": "C000_N1_KINKYU", "3": "C000_N1_KINKYU_3" });
    const rule = (id: string) => REV.rules.find((r) => r.id === id)!;
    expect(rule("R09").kubun).toEqual(expect.arrayContaining(Object.values(C.terminal.terminal)));
    expect(rule("R10").kubun).toEqual(expect.arrayContaining(Object.values(C.oushin.kinkyu)));
    expect(rule("R18").kubun).toEqual(expect.arrayContaining([...Object.values(C.terminal.terminal), ...Object.values(C.oushin.kinkyu), ...kanriKubun(C)]));
  });
});

describe("4 つの種別 × 2 つの族 × 組み合わせの表の全行：R01・R02・R16・R18 の担当どおり", () => {
  /** 申告の種別 g・族 f の患者で、表の行 row を請求したときに出るはずの指摘 */
  function expected(g: FacilityGrade, f: KanriFamily, row: (typeof C.kanri.rows)[number], tier: KanriTierKey, visits: number): string[] {
    const out: string[] = [];
    if (row.family !== f) out.push(f === "施設総管" ? "R16.use_shisetsu" : "R16.use_zaii");
    if (row.grade !== g) out.push("R18.use_grade");
    if (visits === 1 && row.tier !== "ニ") out.push("R01.use_once");
    if (visits === 2 && tier === "ロ" && row.tier === "イ") out.push("R02.not_severe");
    if (visits === 2 && tier === "ロ" && row.tier === "ニ") out.push("R01.use_twice_or_more");
    if (visits === 2 && tier === "イ" && row.tier !== "イ") out.push("R02.use_severe");
    return out.sort();
  }
  const scenarios: { name: string; ctx: ClaimContext; tier: KanriTierKey; visits: number }[] = [
    { name: "月 2 回・重症でない", ctx: K2_PLAIN, tier: "ロ", visits: 2 },
    { name: "月 2 回・重症", ctx: withFact(K2_PLAIN, "table8_2", yes), tier: "イ", visits: 2 },
    { name: "月 1 回", ctx: { ...K2_PLAIN, lines: K2_PLAIN.lines.map((l) => (l.kubun === "C001_1I" ? { ...l, count: 1, dates: [l.dates[0]] } : l)) }, tier: "ニ", visits: 1 },
  ];
  for (const s of scenarios)
    it(s.name, () => {
      let n = 0;
      for (const g of GRADES)
        for (const f of FAMILIES)
          for (const row of ONE) {
            const ctx = withLines(withResidence(withGrade(s.ctx, g), f), line(row.kubun, 1, KANRI_DATE));
            const fs = evaluate(ctx).findings;
            expect(keysOf(fs, ["R01", "R02", "R16", "R18"]), `${g} ${f} ${row.kubun}`).toEqual(expected(g, f, row, s.tier, s.visits));
            // R18 の区分誤りは、申告の種別の同じ族・区分の名称を添える
            const r18 = fs.find((x) => x.messageKey === "R18.use_grade");
            if (r18) expect(r18.params?.fix, row.kubun).toBe(kanriKubunOf(C, row.family, g, row.tier));
            n++;
          }
      expect(n).toBe(4 * 2 * 24);
    });

  it("導出した行を検証に通すと、区分誤り・取り忘れが 0 件（4 種別 × 2 族、ベースアップ評価料は通常・注5）。R18 も言わない", () => {
    for (const g of GRADES)
      for (const f of FAMILIES)
        for (const baseUp of ["通常", "注5"] as const) {
          const c = withResidence(withGrade(K2, g, { baseUp: { known: true, value: baseUp } }), f);
          const r = derive(c);
          expect(r.pending, `${g} ${f} ${baseUp}`).toEqual([]);
          expect(kubunOf(r), `${g} ${f}`).toContain(kanriKubunOf(C, f, g, "ロ"));
          expect(kubunOf(r)).toContain(baseUp === "注5" ? "O001_3I_N5" : "O001_3I");
          const fs = evaluate({ ...c, lines: r.lines }).findings;
          expect(wrongOrMissed(fs), `${g} ${f} ${baseUp}`).toEqual([]);
          expect(fs.filter((x) => x.ruleId === "R18"), `${g} ${f} ${baseUp}`).toEqual([]);
        }
  });

  it("種別が分からない：表の区分の行に R18 の情報不足（facility.grade）。D03 は管理料を保留する", () => {
    const c = withGrade(K2, null);
    expect(keysOf(evaluate(c).findings, ["R18"])).toEqual(["R18:情報不足:facility.grade"]);
    const r = derive(c);
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "facility.grade", target: "clerk" })]);
    expect(kubunOf(r).some((k) => kanriKubun(C).includes(k))).toBe(false);
    expect(r.totalStatus).toBe("withheld");
  });

  it("在宅療養移行加算は種別 3 だけ。ほかの種別では R18 の要件不足", () => {
    for (const g of GRADES) {
      const c = withLines(withGrade(K2, g), line("C002_N9_IKO1", 1, KANRI_DATE));
      expect(keysOf(evaluate(c).findings, ["R18"]).includes("R18.iko_grade3_only"), g).toBe(g !== "3");
    }
  });
});

describe("ベースアップ評価料(Ⅰ) の通常／注5（X-133）", () => {
  const n5 = (c: ClaimContext) => ({ ...c, lines: c.lines.map((l) => (l.kubun === "O001_3I" ? { ...l, kubun: "O001_3I_N5" } : l)) });
  it("注5 の申告で通常の 180725910 に use_baseup_note5、通常の申告で 180854010 に use_baseup_normal。なし は言わない", () => {
    expect(REV.codes.O001_3I.primary).toBe("180725910");
    expect(REV.codes.O001_3I_N5.primary).toBe("180854010");
    const note5 = evaluate({ ...K1, facility: { ...K1.facility, baseUp: { known: true, value: "注5" } } }).findings.filter((f) => f.ruleId === "R18");
    expect(note5.map((f) => [f.messageKey, f.lineRefs, f.params?.fix])).toEqual([["R18.use_baseup_note5", ["O001_3I"], "O001_3I_N5"]]);
    const normal = evaluate(n5(K1)).findings.filter((f) => f.ruleId === "R18");
    expect(normal.map((f) => [f.messageKey, f.lineRefs, f.params?.fix])).toEqual([["R18.use_baseup_normal", ["O001_3I_N5"], "O001_3I"]]);
    expect(evaluate({ ...K1, facility: { ...K1.facility, baseUp: { known: true, value: "なし" } } }).findings.filter((f) => f.ruleId === "R18")).toEqual([]);
    // R08 は通常・注5 を合わせて訪問診療時／再診時等だけを見る（注5 の行でも訪問診療の日なら言わない）
    expect(evaluate(n5(K1)).findings.filter((f) => f.ruleId === "R08")).toEqual([]);
  });
  it("分からない：R18 の情報不足（facility.baseUp）と、D07 の保留", () => {
    const c = { ...K1, facility: { ...K1.facility, baseUp: unknown } };
    expect(keysOf(evaluate(c).findings, ["R18"])).toEqual(["R18:情報不足:facility.baseUp"]);
    expect(derive({ ...K2, facility: { ...K2.facility, baseUp: unknown } }).pending).toEqual([expect.objectContaining({ need: "facility.baseUp" })]);
  });
  it("注5 の申告で、導出は O001_*_N5 を立てる（往診だけの日は再診時等の注5）", () => {
    const c = { ...K5, facility: { ...K5.facility, baseUp: { known: true, value: "注5" } } } as ClaimContext;
    const r = derive(c);
    expect(kubunOf(r)).toEqual(expect.arrayContaining(["O001_3I_N5", "O001_2_N5"]));
    expect(kubunOf(r)).not.toContain("O001_3I");
    expect(wrongOrMissed(evaluate({ ...c, lines: r.lines }).findings)).toEqual([]);
  });
});

describe("種別が分からない施設の往診の翌日・同じ日の訪問診療（X-134）", () => {
  const O = day(13);
  const base = withGrade(withFact(K2, "contactDocProvided", yes), null);
  const afterOushin = { ...base, events: [...base.events, { type: "oushin" as const, date: O, kind: "normal" as const }], lines: [...base.lines.map((l) => (l.kubun === "C001_1I" ? l : l)), line("C000", 1, [O])] };
  it("往診の翌日の訪問診療料：R10 は情報不足（facility.grade）を返し、通過・要件不足にならない（文書提供が真でも）。D01 はその日を保留", () => {
    const r10 = evaluate(afterOushin).findings.filter((f) => f.ruleId === "R10");
    expect(r10.map((f) => [f.kind, f.missing?.field])).toEqual([["情報不足", "facility.grade"]]);
    const r = derive(afterOushin);
    expect(r.pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: `D01-doc:${day(14)}`, need: "facility.grade" })]));
    expect(r.lines.find((l) => l.kubun === "C001_1I")?.dates ?? []).not.toContain(day(14));
    expect(r.totalStatus).toBe("withheld");
  });
  it("同じ日の別々の診療（訪問診療のあとの往診）：R10 は情報不足（facility.grade）。D01 はその日の訪問診療料を保留", () => {
    const D = day(14);
    const c = withFact({ ...base, events: [...base.events, { type: "oushin" as const, date: D, kind: "normal" as const }], lines: [...base.lines, line("C000", 1, [D])] }, "sameDayOushinAfterVisit", { known: true, value: { [D]: true } });
    expect(evaluate(c).findings.filter((f) => f.ruleId === "R10").map((f) => [f.kind, f.missing?.field])).toEqual([["情報不足", "facility.grade"]]);
    const r = derive(c);
    expect(r.pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: `D01-doc:${D}`, need: "facility.grade" })]));
    expect(r.lines.find((l) => l.kubun === "C001_1I")?.dates ?? []).not.toContain(D);
  });
});

describe("R09・R10 の種別ごとの区分（X-135・X-139）", () => {
  const DEATH = K5.events.find((e) => e.type === "death")!.date;
  for (const [g, kubun] of Object.entries(C.terminal.terminal) as [FacilityGrade, string][])
    it(`在宅ターミナルケア加算 ${kubun}：15 日間の実施が 1 回なら terminal_visits、2 回なら言わない。記録のない請求は情報不足`, () => {
      const base = withGrade(withFact({ ...K5, lines: [...K5.lines.filter((l) => l.kubun !== "C001_N6_TERMINAL"), line(kubun, 1, [DEATH])] }, "dischargeJointGuidance", no), g);
      const once = { ...base, events: base.events.filter((e) => !(e.type === "visit" && e.date === day(12)) && e.type !== "oushin") };
      expect(evaluate(once).findings.filter((f) => f.ruleId === "R09").map((f) => [f.messageKey, f.lineRefs])).toEqual([["R09.terminal_visits", [kubun]]]);
      expect(evaluate(base).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
      const noRecords = evaluate({ ...once, events: [], recordsKnown: false }).findings.filter((f) => f.ruleId === "R09");
      expect(noRecords.map((f) => [f.kind, f.missing?.field])).toEqual([["情報不足", "chartRecord"]]);
    });
  for (const [g, kubun] of Object.entries(C.oushin.kinkyu) as [FacilityGrade, string][])
    it(`緊急往診加算 ${kubun}：対象でなければ kinkyu_not_eligible（その区分の行）、不明なら情報不足、対象なら言わない`, () => {
      const O = day(20);
      const c = withGrade(withLines(K1, line("C000", 1, [O]), line(kubun, 1, [O])), g);
      const r10 = (eligible: ClaimContext["facts"]["emergencyEligible"]) => evaluate(withFact(c, "emergencyEligible", eligible)).findings.filter((f) => f.ruleId === "R10" && (f.lineRefs.includes(kubun) || f.messageKey === "R10.kinkyu_not_eligible"));
      expect(r10(no).map((f) => [f.messageKey, f.lineRefs])).toEqual([["R10.kinkyu_not_eligible", [kubun]]]);
      expect(r10(unknown).map((f) => [f.kind, f.missing?.field, f.lineRefs])).toEqual([["情報不足", "emergencyEligible", [kubun]]]);
      expect(r10(yes)).toEqual([]);
    });
  it("導出：緊急往診加算と在宅ターミナルケア加算は申告の種別の区分で立つ。種別が分からなければ事実不足", () => {
    const em = withFact({ ...K2, events: [...K2.events, { type: "oushin" as const, date: day(20), kind: "emergency" as const }] }, "emergencyEligible", yes);
    for (const g of GRADES) {
      expect(kubunOf(derive(withGrade(em, g))), g).toContain(C.oushin.kinkyu[g]);
      expect(kubunOf(derive(withGrade(K5, g))), g).toContain(C.terminal.terminal[g]);
    }
    expect(derive(withGrade(em, null)).pending.map((p) => p.kind === "事実不足" && p.need)).toContain("facility.grade");
    expect(derive(withGrade(K5, null)).pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: `D12-grade:${DEATH}`, need: "facility.grade" })]));
  });
});

describe("derivedKubun・g11Owned・kubunFamily（C-234・C-230・C-250）", () => {
  const derived = derivedKubun(C);
  it("derivedKubun は表の全区分と O001 の通常・注5 を含み、在宅療養移行加算1〜4 と C〜I に回した区分を含まない", () => {
    expect(derived).toEqual(expect.arrayContaining([...kanriKubun(C), ...Object.values(C.terminal.terminal), ...Object.values(C.oushin.kinkyu), "O001_3I", "O001_3RO", "O001_2", "O001_3I_N5", "O001_3RO_N5", "O001_2_N5"]));
    for (const k of [...C.ikouGrade3!, ...C.deferred!]) expect(derived, k).not.toContain(k);
  });
  it("取り込んだ行の C000_N1_KINKYU_3・C001_N6_TERMINAL_1B・在医総管の 1B が manual に流れず、算定プレビューで同じ行が 2 行にならない。manual に入れると例外", () => {
    const lines: ClaimLine[] = [...K5.lines, line("C000_N1_KINKYU_3", 1, [day(22)]), line("C001_N6_TERMINAL_1B", 1, [day(22)]), line("C002_1B_RO1", 1, [day(19)])];
    const manual = manualLinesOf(lines, REV);
    for (const k of ["C000_N1_KINKYU_3", "C001_N6_TERMINAL_1B", "C002_1B_RO1"]) expect(manual.map((l) => l.kubun), k).not.toContain(k);
    const r = derive(withGrade({ ...K5, lines }, "1B"), { manual });
    const counts = new Map<string, number>();
    for (const l of r.lines) counts.set(l.kubun, (counts.get(l.kubun) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
    for (const k of ["C000_N1_KINKYU_3", "C001_N6_TERMINAL_1B", "C002_1B_RO1"]) expect(() => derive(K5, { manual: [line(k)] }), k).toThrow(/manual に導出する区分/);
  });
  it("g11Owned は derivedKubun の部分集合で、差は D09・D10 の区分（検体検査・血液採取・判断料・処方箋料）", () => {
    const owned = g11Owned(C);
    expect(owned.filter((k) => !derived.includes(k))).toEqual([]);
    const d0910 = [C.tests.bloodDraw, ...Object.values(C.testItems).map((t) => t.kubun), ...C.tests.judgement, C.rx.many, C.rx.other];
    expect(derived.filter((k) => !owned.includes(k)).sort()).toEqual([...new Set(d0910)].sort());
  });
  it("kubunFamily は表・O001 の組・R08 の区分から作られ、管理料は族ごとに 1 つにまとまる", () => {
    const fam = kubunFamily(C);
    for (const r of C.kanri.rows) expect(fam[r.kubun], r.kubun).toBe(r.family);
    expect(new Set(Object.values(C.terminal.terminal).map((k) => fam[k])).size).toBe(1);
    expect(new Set(Object.values(C.oushin.kinkyu).map((k) => fam[k])).size).toBe(1);
    expect(new Set(["O001_3I", "O001_3RO", "O001_2", "O001_3I_N5", "O001_3RO_N5", "O001_2_N5"].map((k) => fam[k])).size).toBe(1);
    expect(fam.O001_1).toBe(fam.O001_1_N5);
    expect(fam.O001_1).not.toBe(fam.O001_3I);
    expect(new Set(gradeSlots(C).map((s) => fam[s.kubun])).size).toBe(4);
  });
  it("表は人数の次元（band）を持てる：band の行を足した定数でも、derivedKubun・R18 の表に入り、D03 は 1 人の区分を選ぶ", () => {
    const banded: RevisionConsts = { ...C, kanri: { ...C.kanri, rows: [...C.kanri.rows, { kubun: "C002_2RO1", family: "在医総管", grade: "2", tier: "ロ", band: "2-9" }] } };
    expect(gradeSlots(banded).filter((s) => s.kubun === "C002_2RO1").map((s) => s.slot)).toEqual(["在医総管/ロ//", "在医総管/ロ/2-9/"]);
    expect(kanriKubunOf(banded, "在医総管", "2", "ロ")).toBe("C002_2RO1");
    expect(derivedKubun(banded)).toContain("C002_2RO1");
  });
});

describe("申告だけを根拠に点数の高い区分へ直さない（C-251）", () => {
  // 訪問診療料 2 回・重症でない・注16 を満たす → 期待は ロ。行は ニ
  const NI = withLines(K2_PLAIN, line("C002_2NI1", 1, KANRI_DATE));
  const r01 = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R01");
  it("note16Met が申告から来て真：ニ の行に use_twice_or_more を出さず、情報不足（facility.note16Met）と食い違いの文", () => {
    const fs = r01({ ...NI, facilityBasis: { note16Met: "declaration" } });
    expect(fs.map((f) => [f.kind, f.messageKey, f.missing?.field, f.lineRefs])).toEqual([["情報不足", "R01.declaration_conflict", "facility.note16Met", ["C002_2NI1"]]]);
    expect(findingText(fs[0])).toContain("申告（注16 の基準を満たす）と請求が食い違っています。申告を確かめてください");
    expect(findingText(fs[0])).toContain("施設の申告の画面");
  });
  it("症例ごとの上書き・単体テストの facility で渡すと、今までどおり use_twice_or_more", () => {
    for (const basis of [undefined, { note16Met: "case" as const }, { note16Met: "config" as const }]) expect(r01({ ...NI, facilityBasis: basis }).map((f) => f.messageKey)).toEqual(["R01.use_twice_or_more"]);
  });
  it("申告から来て偽で ロ の行には、今までどおり note16_once_rate（点数の低い側へ直す）", () => {
    const RO = withLines(K2_PLAIN, line("C002_2RO1", 1, KANRI_DATE));
    expect(r01({ ...RO, facility: { ...RO.facility, note16Met: no }, facilityBasis: { note16Met: "declaration" } }).map((f) => f.messageKey)).toEqual(["R01.note16_once_rate"]);
  });
  it("届出の裏付けがある申告（種別）は当たらない：機能強化型の申告で在支診の在医総管のコードに R18 use_grade", () => {
    const c = { ...withGrade(withLines(K2_PLAIN, line("C002_2RO1", 1, KANRI_DATE)), "1N"), facilityBasis: { grade: "declaration" as const, note16Met: "declaration" as const } };
    expect(REV.codes.C002_2RO1.primary).toBe("114032810");
    expect(evaluate(c).findings.filter((f) => f.ruleId === "R18").map((f) => [f.messageKey, f.params?.fix])).toEqual([["R18.use_grade", "C002_1N_RO1"]]);
  });
  it("直し先の点数が未収載のときも、高い側とみなして情報不足", () => {
    const points = { ...REV.points, C002_2RO1: { ...REV.points.C002_2RO1, points: null, source: "未収載" as const } };
    const rule = makeR01(C, points);
    const ctx = { ...NI, lines: NI.lines, facilityBasis: { note16Met: "declaration" as const } };
    expect(rule.check(ctx).map((f) => f.messageKey)).toEqual(["R01.declaration_conflict"]);
  });
});

describe("連携型の申告の断り（docs M-8）と C〜I に回した区分（L-92）", () => {
  const RO = withLines(K2_PLAIN, line("C002_2RO1", 1, KANRI_DATE));
  it("種別が (2)ア・(2)イ の申告で R18 の文に経過措置の断りが付き、(3) では付かない", () => {
    const text = (choice: string, g: FacilityGrade) => findingText(evaluate(withGrade(RO, g, { gradeChoice: choice })).findings.find((f) => f.ruleId === "R18")!);
    expect(text("renkei_a_beds", "1B")).toContain("（令和8年5月以前に届け出た連携型の経過措置は未確認）");
    expect(text("renkei_a_nobeds", "1N")).toContain("経過措置は未確認");
    // (2)イ・(3) は種別 2（在支診の区分）なので、在支診の行には R18 が出ない。種別 3 の行で比べる
    const RO3 = withLines(K2_PLAIN, line("C002_3RO1", 1, KANRI_DATE));
    const r18 = (choice: string) => findingText(evaluate(withGrade(RO3, "2", { gradeChoice: choice })).findings.find((f) => f.ruleId === "R18")!);
    expect(r18("renkei_i")).toContain("経過措置は未確認");
    expect(r18("zaishishin3")).not.toContain("経過措置");
    expect(r18("zaishishin3")).toContain("在医総管 2ロ(1) 月2回以上");
  });
  it("請求に充実体制・実績・在宅療養移行・注8 の減算の行があると、点検の範囲に「見ていません」と件数。R ルールの指摘は出ない（移行加算の種別のほか）", () => {
    const lines = [...K2.lines, line("C002_N7_JUJITSU1", 1, KANRI_DATE), line("C001_N6_JISSEKI1", 1, [day(14)]), line("C002_N8_GENSAN", 1, KANRI_DATE)];
    expect(deferredNote(lines, REV)).toBe("在宅医療充実体制加算・在宅療養実績加算・在宅療養移行加算・注8 の減算の算定の要件と取り忘れは見ていません（届出の有無だけ G10 が見ています）：3 行");
    const fs = evaluate({ ...K2, lines }).findings;
    expect(fs.filter((f) => f.lineRefs.some((k) => C.deferred!.includes(k)))).toEqual([]);
    expect(deferredNote(K2.lines, REV)).toBeNull();
    // 注8 の減算の対象になる管理料（種別 3 の管理料）も数える
    expect(deferredNote([line("C002_3RO1")], REV)).toContain("1 行");
  });
});

describe("R18 の単体", () => {
  // 段 17h で注14 の use_note14_reduced を足して 5 種類（行と申告だけで決まる）
  it("行がなければ当たらない。soundWhenPartial は 5 種類", () => {
    const r = makeR18(C, REV.points);
    expect(r.appliesTo({ ...K2_PLAIN, lines: [] })).toBe(false);
    expect(r.soundWhenPartial.sort()).toEqual(["iko_grade3_only", "use_baseup_normal", "use_baseup_note5", "use_grade", "use_note14_reduced"]);
  });
});
