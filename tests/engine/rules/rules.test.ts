// design.md §7 #1：R01〜R16 それぞれ「違反なし」「違反あり」の最小例（§2-3-1 の表と 1 対 1）と、
// 管理料の区分の組み合わせ（§2-3-3）、往診と訪問診療の同日・翌日（§2-3-4）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../../src/engine";
import type { ClaimContext, Facility, FacilityFactKey, Fact, Finding, FindingKind } from "../../../src/engine/types";
import { day, month } from "../../helpers/period";
import { line, loadCase, withEvents, withFact, withLines, without } from "../helpers";

const K1 = loadCase("K1");
const K2 = loadCase("K2");
const K4 = loadCase("K4");
const K6 = loadCase("K6");
const K7 = loadCase("K7");

/** K1・K2 の訪問診療は 14 日と 28 日。22 日は訪問診療のない平日 */
const FIRST = day(14);
const SECOND = day(28);
const OTHER = day(22);

const yes: Fact<boolean> = { known: true, value: true };
const no: Fact<boolean> = { known: true, value: false };
const unknown = { known: false } as const;

const withFacility = <K extends FacilityFactKey>(ctx: ClaimContext, key: K, value: Facility[K]): ClaimContext => ({ ...ctx, facility: { ...ctx.facility, [key]: value } });
/** 行の回数と日付を差し替える */
const setDates = (ctx: ClaimContext, kubun: string, dates: string[]): ClaimContext => ({ ...ctx, lines: ctx.lines.map((l) => (l.kubun === kubun ? { ...l, count: dates.length, dates } : l)) });
const replaceKubun = (ctx: ClaimContext, from: string, to: string): ClaimContext => ({ ...ctx, lines: ctx.lines.map((l) => (l.kubun === from ? { ...l, kubun: to } : l)) });
const separate = (ctx: ClaimContext, table: Record<string, boolean>) => withFact(ctx, "sameDaySeparate", { known: true, value: table });

const of = (ctx: ClaimContext, ...ruleIds: string[]): Finding[] => evaluate(ctx).findings.filter((f) => ruleIds.includes(f.ruleId));
const kinds = (ctx: ClaimContext, ruleId: string): FindingKind[] => of(ctx, ruleId).map((f) => f.kind);
/** 指摘を「ルール:種類:キー」の形で（キーは R01.xxx の xxx。情報不足は足りない項目） */
const tags = (ctx: ClaimContext, ...ruleIds: string[]): string[] =>
  of(ctx, ...ruleIds).map((f) => `${f.ruleId}:${f.kind}:${f.kind === "情報不足" ? f.missing?.field : f.messageKey.split(".")[1]}`);

/** 管理料のない月（処方箋料を算定できる）。R06・R07 の確認用 */
const NO_KANRI = withLines(without(K1, "C002_2I1", "C002_N15_RENKEI"), line("F400_3", 1, [SECOND]), line("F400_N4", 1, [SECOND]), line("F400_N6_1", 1, [SECOND]));
/** K1 に、訪問診療料のない日（22 日）の往診料を足す */
const K1_OUSHIN = withEvents(withLines(K1, line("C000", 1, [OTHER])), { type: "oushin", date: OTHER, kind: "normal" });
/** K1 の 14 日に往診料も算定する（同じ日に両方の行） */
const K1_BOTH = withLines(K1, line("C000", 1, [FIRST]));
/** K1 の 28 日の前日（27 日）に往診料を算定する（往診料の翌日に訪問診療料） */
const K1_DAY_AFTER = withLines(K1, line("C000", 1, [day(27)]));

type Case = { id: string; ok: ClaimContext; ng: ClaimContext; kind: FindingKind; key: string };

const cases: Case[] = [
  { id: "R01", ok: K1, ng: without(K1, "C001_1I", "O001_3I", "O100_1HA"), kind: "区分誤り", key: "no_visit" },
  { id: "R02", ok: K1, ng: replaceKubun(K1, "C002_2I1", "C002_2RO1"), kind: "区分誤り", key: "use_severe" },
  { id: "R03", ok: K2, ng: withFact(K2, "careLevel", { known: true, value: 2 }), kind: "要件不足", key: "not_eligible" },
  { id: "R04", ok: K1, ng: withLines(K1, line("C101_2I")), kind: "背反", key: "only_main" },
  { id: "R05", ok: K1, ng: withLines(K1, line("B000")), kind: "背反", key: "bundled" },
  {
    id: "R06",
    ok: NO_KANRI,
    ng: withLines(without(K2, "C002_2RO1", "C002_N4_IKOU", "C002_N10_HOKATSU"), line("F400_3", 1, [SECOND]), line("F400_N4", 1, [SECOND])),
    kind: "要件不足",
    key: "excluded_disease",
  },
  { id: "R07", ok: NO_KANRI, ng: { ...NO_KANRI, events: NO_KANRI.events.map((e) => (e.type === "prescription" ? { ...e, oralKinds: 7 } : e)) }, kind: "区分誤り", key: "use_seven_or_more" },
  { id: "R08", ok: K1, ng: setDates(K1_OUSHIN, "O001_3I", [FIRST, OTHER, SECOND]), kind: "区分誤り", key: "oushin_only_day" },
  {
    id: "R09",
    ok: withEvents(withLines(K1, line("C001_N7_MITORI", 1, [SECOND])), { type: "death", date: SECOND }),
    ng: withEvents(withLines(K1, line("C001_N7_MITORI", 1, [SECOND]), line("C001_N8_SHIBOU", 1, [SECOND])), { type: "death", date: SECOND }),
    kind: "背反",
    key: "mitori_with_shibou",
  },
  { id: "R10", ok: K1_OUSHIN, ng: separate(K1_BOTH, { [FIRST]: false }), kind: "背反", key: "same_encounter" },
  { id: "R11", ok: K1, ng: without(K1, "D026_5"), kind: "区分誤り", key: "bnp_is_biochem2" },
  { id: "R12", ok: K1, ng: withLines(K1, line("A_DENSHI_RENKEI")), kind: "背反", key: "same_month" },
  { id: "R13", ok: K1, ng: setDates(K1, "C001_1I", [day(12), day(13), FIRST, day(15), SECOND]), kind: "要件不足", key: "over_three_a_week" },
  { id: "R14", ok: K2, ng: { ...K2, events: K2.events.map((e) => (e.type === "kanriStart" ? { ...e, month: month(-3) } : e)) }, kind: "要件不足", key: "not_eligible" },
  { id: "R15", ok: K1, ng: setDates(K1_OUSHIN, "O100_1HA", [FIRST, OTHER, SECOND]), kind: "区分誤り", key: "oushin_only_day" },
  { id: "R16", ok: K4, ng: replaceKubun(K4, "C002-2_2RO1", "C002_2RO1"), kind: "区分誤り", key: "use_shisetsu" },
];

describe.each(cases)("$id", ({ id, ok, ng, kind, key }) => {
  it("違反なし", () => {
    expect(kinds(ok, id)).toEqual([]);
    expect(evaluate(ok).applied).toContain(id);
  });
  it("違反あり", () => {
    expect(tags(ng, id)).toContain(`${id}:${kind}:${key}`);
  });
});

// ---------------------------------------------------------------------------
// 管理料の区分（§2-3-3）。族は居住の場所で決まり、区分は 回数 → 重症 → 注16 の順に決まる

const KANRI = { 在医総管: { イ: "C002_2I1", ロ: "C002_2RO1", ニ: "C002_2NI1" }, 施設総管: { イ: "C002-2_2I1", ロ: "C002-2_2RO1", ニ: "C002-2_2NI1" } } as const;
type Family = keyof typeof KANRI;
type Tier = "イ" | "ロ" | "ニ";

/** 組み合わせの 1 マス：K4 を土台に、族・訪問診療料の回数・重症・注16・請求した区分を差し替える（要介護 2 で、包括的支援加算の行はない） */
function kanriCase(family: Family, visits: number, severe: Fact<boolean>, note16: Fact<boolean>, tier: Tier): ClaimContext {
  const dates = [day(13), day(27), day(20)].slice(0, visits);
  let c = withFact(withFact(K4, "careLevel", { known: true, value: 2 }), "table8_2", severe);
  c = withFact(c, "residence", { known: true, value: family === "在医総管" ? "居宅" : "施設入居等" });
  c = withFacility(c, "note16Met", note16);
  c = replaceKubun(c, "C002-2_2RO1", KANRI[family][tier]);
  for (const k of ["C001_1I", "O001_3I", "O100_1HA"]) c = visits === 0 ? without(c, k) : setDates(c, k, dates);
  return c;
}

type Row = { name: string; visits: number; severe: Fact<boolean>; note16: Fact<boolean>; expect: Record<Tier, string[]> };
const ANY = [yes, no, unknown];
const rows: Row[] = [
  ...ANY.flatMap((s, i) => ANY.map((n, j) => ({ name: `回数 0（重症 ${i}・注16 ${j} は見ない）`, visits: 0, severe: s, note16: n, expect: { イ: ["R01:区分誤り:no_visit"], ロ: ["R01:区分誤り:no_visit"], ニ: ["R01:区分誤り:no_visit"] } }))),
  ...ANY.flatMap((s, i) => ANY.map((n, j) => ({ name: `回数 1（重症 ${i}・注16 ${j} は見ない）`, visits: 1, severe: s, note16: n, expect: { イ: ["R01:区分誤り:use_once"], ロ: ["R01:区分誤り:use_once"], ニ: [] } }))),
  ...ANY.map((n, j) => ({ name: `回数 2・重症（注16 ${j} は見ない）`, visits: 2, severe: yes, note16: n, expect: { イ: [], ロ: ["R02:区分誤り:use_severe"], ニ: ["R02:区分誤り:use_severe"] } })),
  { name: "回数 2・重症でない・注16 の基準を満たす", visits: 2, severe: no, note16: yes, expect: { イ: ["R02:区分誤り:not_severe"], ロ: [], ニ: ["R01:区分誤り:use_twice_or_more"] } },
  { name: "回数 2・重症でない・注16 の基準を満たさない", visits: 2, severe: no, note16: no, expect: { イ: ["R02:区分誤り:not_severe"], ロ: ["R01:区分誤り:note16_once_rate"], ニ: [] } },
  { name: "回数 2・重症でない・注16 が不明", visits: 2, severe: no, note16: unknown, expect: { イ: ["R02:区分誤り:not_severe"], ロ: ["R01:情報不足:facility.note16Met"], ニ: ["R01:情報不足:facility.note16Met"] } },
  ...ANY.map((n, j) => ({ name: `回数 3・重症かどうかが不明（注16 ${j} は聞かない）`, visits: 3, severe: unknown, note16: n, expect: { イ: ["R02:情報不足:table8_2"], ロ: ["R02:情報不足:table8_2"], ニ: ["R02:情報不足:table8_2"] } })),
];

describe.each(["在医総管", "施設総管"] as Family[])("管理料の区分の組み合わせ（%s）", (family) => {
  it.each(rows)("$name", (row) => {
    for (const tier of ["イ", "ロ", "ニ"] as Tier[]) {
      const c = kanriCase(family, row.visits, row.severe, row.note16, tier);
      const got = tags(c, "R01", "R02");
      expect(got, `請求した区分 ${tier}`).toEqual(row.expect[tier]);
      // 1 つの管理料の行に出る区分の指摘（R01・R02）は 1 件以下。族の取り違えではないので R16 は出ない
      expect(got.length).toBeLessThanOrEqual(1);
      expect(tags(c, "R16")).toEqual([]);
    }
  });
});

describe("管理料：指摘の担当と宛先", () => {
  it("重症・2ロ・回数 2・注16 の基準を満たさない施設でも、出るのは R02 の use_severe だけ（R01 と逆向きにならない。C-63）", () => {
    const c = withFacility(replaceKubun(K1, "C002_2I1", "C002_2RO1"), "note16Met", no);
    expect(tags(c, "R01", "R02", "R03")).toEqual(["R02:区分誤り:use_severe"]);
    expect(tags(withFacility(c, "note16Met", unknown), "R01", "R02", "R03")).toEqual(["R02:区分誤り:use_severe"]);
  });
  it("K7：注16 の基準を満たさない施設は、月 2 回でも 2ニ で指摘なし。2ロ にすると note16_once_rate", () => {
    expect(evaluate(K7).findings).toEqual([]);
    expect(tags(replaceKubun(K7, "C002_2NI1", "C002_2RO1"), "R01", "R02", "R03")).toEqual(["R01:区分誤り:note16_once_rate"]);
    expect(tags(withFacility(K2, "note16Met", no), "R01")).toEqual(["R01:区分誤り:note16_once_rate"]);
  });
  it("施設総管 2ロ・回数 2・重症でない・注16 の基準を満たさない → R01 note16_once_rate（X-63）", () => {
    const c = withFacility(withFact(K4, "careLevel", { known: true, value: 2 }), "note16Met", no);
    expect(evaluate(c).findings.map((f) => [f.ruleId, f.messageKey, f.lineRefs])).toEqual([["R01", "R01.note16_once_rate", ["C002-2_2RO1"]]]);
  });
  it("注16 の情報不足は医療事務あてで、field は facility.note16Met", () => {
    const f = of(withFacility(K2, "note16Met", unknown), "R01");
    expect(f).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "facility.note16Met" } })]);
  });
  it("重症かどうかの情報不足は医師あて", () => {
    const f = of(withFact(K1, "table8_2", unknown), "R01", "R02", "R03");
    expect(f).toEqual([expect.objectContaining({ ruleId: "R02", kind: "情報不足", missing: { target: "doctor", field: "table8_2" } })]);
  });
});

describe("K1（重症・要介護 3）の月末の 2 つの時点で、指摘が同じ行き先を指す（§2-3-3 の K1 の表。C-68）", () => {
  const HOKATSU = line("C002_N10_HOKATSU", 1, [SECOND]);
  /** 訪問診療料が 1 回で終わった月の K1 */
  const once = (c: ClaimContext) => ["C001_1I", "O001_3I", "O100_1HA"].reduce((x, k) => setDates(x, k, [FIRST]), c);
  const cell = (visits: 1 | 2, tier: Tier, add: boolean) => {
    const c = replaceKubun(visits === 1 ? once(K1) : K1, "C002_2I1", KANRI.在医総管[tier]);
    return tags(add ? withLines(c, HOKATSU) : c, "R01", "R02", "R03");
  };
  it("回数 2：イ は加算なしで 0 件、加算ありは R02 の背反（加算を外す）", () => {
    expect(cell(2, "イ", false)).toEqual([]);
    expect(cell(2, "イ", true)).toEqual(["R02:背反:severe_with_hokatsu"]);
  });
  it.each(["ロ", "ニ"] as Tier[])("回数 2：%s は use_severe。加算があれば背反も出る", (tier) => {
    expect(cell(2, tier, false)).toEqual(["R02:区分誤り:use_severe"]);
    expect(cell(2, tier, true)).toEqual(["R02:区分誤り:use_severe", "R02:背反:severe_with_hokatsu"]);
  });
  it.each(["イ", "ロ"] as Tier[])("回数 1：%s は use_once（ニ に）。加算がなければ R03 の取り忘れも出る。R02 は出ない", (tier) => {
    expect(cell(1, tier, false)).toEqual(["R01:区分誤り:use_once", "R03:取り忘れ:missing"]);
    expect(cell(1, tier, true)).toEqual(["R01:区分誤り:use_once"]);
  });
  it("回数 1：ニ は加算なしで R03 の取り忘れ、加算ありで 0 件（重症の患者を一律に加算の対象外にしない）", () => {
    expect(cell(1, "ニ", false)).toEqual(["R03:取り忘れ:missing"]);
    expect(cell(1, "ニ", true)).toEqual([]);
  });
});

describe("R03 包括的支援加算（施設総管にも当たる。C-66）", () => {
  it("K4（施設総管 2ロ）：要介護度が不明なら情報不足、要介護 2 を入れると 0 件、要介護 2 で加算を立てると not_eligible", () => {
    expect(tags(K4, "R03")).toEqual(["R03:情報不足:careLevel"]);
    const care2 = withFact(K4, "careLevel", { known: true, value: 2 });
    expect(evaluate(care2).findings).toEqual([]);
    expect(tags(withLines(care2, line("C002_N10_HOKATSU", 1, [day(27)])), "R03")).toEqual(["R03:要件不足:not_eligible"]);
  });
  it("要介護 3 の施設総管 2ロ で加算がなければ取り忘れ", () => {
    expect(tags(withFact(K4, "careLevel", { known: true, value: 3 }), "R03")).toEqual(["R03:取り忘れ:missing"]);
  });
});

describe("R05・R14（施設総管にも当たる）", () => {
  it("在医総管の月に処方箋料と、それに付く加算を立てると背反（EM #7-6）", () => {
    const f = of(withLines(K1, line("F400_3", 1, [SECOND]), line("F400_N4", 1, [SECOND])), "R05");
    expect(f).toEqual([expect.objectContaining({ kind: "背反", lineRefs: ["F400_3", "F400_N4"] })]);
  });
  it("施設総管の月の処方箋料も背反", () => {
    expect(tags(withLines(K4, line("F400_3", 1, [day(27)])), "R05")).toEqual(["R05:背反:bundled"]);
  });
  it("管理料のない月の処方箋料は指摘しない", () => {
    expect(kinds(NO_KANRI, "R05")).toEqual([]);
  });
  it("施設総管の月でも、在宅移行早期加算の取り忘れを出す", () => {
    const c = withEvents(K4, { type: "discharge", date: `${month(-3)}-17` }, { type: "kanriStart", month: month(-2) });
    expect(tags(c, "R14")).toEqual(["R14:取り忘れ:missing"]);
  });
});

// ---------------------------------------------------------------------------
// R08・R15：訪問診療の日は、訪問診療料を算定した行の日で決める。両方を算定した日の重ねは、加算ごとの施設の設定で決める

describe("R08・R15 訪問診療時と再診時等", () => {
  /** 14 日に訪問診療料と往診料の両方（別々の診療と確かめ済み）。ベースアップ評価料・物価対応料の再診時等を重ねる */
  const BOTH = separate(K1_BOTH, { [FIRST]: true });
  const OVERLAP_BU = withLines(BOTH, line("O001_2", 1, [FIRST]));
  const OVERLAP_PRICE = withLines(BOTH, line("O100_1RO", 1, [FIRST]));

  it("R08：重ねた行があり、設定が不明なら情報不足（clerk, facility.revisitBaseUpSameDay）", () => {
    expect(of(OVERLAP_BU, "R08")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "facility.revisitBaseUpSameDay" } })]);
  });
  it("R08：設定が偽なら背反 no_revisit_on_both_day。指すのは再診時等の行だけで、区分誤りは出ない。その行を外すと 0 件", () => {
    const f = of(withFacility(OVERLAP_BU, "revisitBaseUpSameDay", no), "R08");
    expect(f.map((x) => [x.kind, x.messageKey, x.lineRefs])).toEqual([["背反", "R08.no_revisit_on_both_day", ["O001_2"]]]);
    expect(tags(withFacility(BOTH, "revisitBaseUpSameDay", no), "R08")).toEqual([]);
  });
  it("R08：設定が真なら 0 件", () => {
    expect(tags(withFacility(OVERLAP_BU, "revisitBaseUpSameDay", yes), "R08")).toEqual([]);
  });
  it("R08：両方を算定した日でも、片方の区分だけなら設定によらず 0 件（C-71）", () => {
    const onlyRevisit = setDates(OVERLAP_BU, "O001_3I", [SECOND]);
    for (const v of [yes, no, unknown]) {
      expect(tags(withFacility(BOTH, "revisitBaseUpSameDay", v), "R08")).toEqual([]);
      expect(tags(withFacility(onlyRevisit, "revisitBaseUpSameDay", v), "R08")).toEqual([]);
    }
  });
  it("R08：訪問診療料だけの日の再診時等は、訪問診療時の区分がその日になければ use_visit（区分誤り）", () => {
    expect(tags(setDates(withLines(K1, line("O001_2", 1, [FIRST])), "O001_3I", [SECOND]), "R08")).toEqual(["R08:区分誤り:use_visit"]);
  });
  it("R08：その日に訪問診療時の区分がすでにあれば、置き換えではなく背反 duplicate_on_visit_day。その行を外すと 0 件（C-78）", () => {
    expect(tags(withLines(K1, line("O001_2", 1, [FIRST])), "R08")).toEqual(["R08:背反:duplicate_on_visit_day"]);
    expect(tags(K1, "R08")).toEqual([]);
  });
  it("R08：訪問の出来事があっても、訪問診療料の行のない日は訪問診療の日に数えない（C-65）", () => {
    // 22 日：訪問の出来事はあるが、算定したのは往診料。再診時等の区分で正しい
    const c = withEvents(withLines(K1, line("C000", 1, [OTHER]), line("O001_2", 1, [OTHER])), { type: "visit", date: OTHER, sameBuildingCount: 1 });
    expect(tags(c, "R08")).toEqual([]);
    // 同じ日に訪問診療時の区分を立てると誤り（出来事ではなく行で決まる）
    expect(tags(setDates(c, "O001_3I", [FIRST, OTHER, SECOND]), "R08")).toContain("R08:区分誤り:oushin_only_day");
  });
  it("R15：重ねた行は、物価対応料用の設定だけで決まる（不明 → 情報不足、偽 → 背反で再診時等の行だけ、真 → 0 件）", () => {
    expect(of(OVERLAP_PRICE, "R15")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "facility.revisitPriceSameDay" } })]);
    const f = of(withFacility(OVERLAP_PRICE, "revisitPriceSameDay", no), "R15");
    expect(f.map((x) => [x.kind, x.messageKey, x.lineRefs])).toEqual([["背反", "R15.no_revisit_on_both_day", ["O100_1RO"]]]);
    expect(tags(withFacility(OVERLAP_PRICE, "revisitPriceSameDay", yes), "R15")).toEqual([]);
  });
  it("両方の加算が重なっているとき、片方の設定はもう片方に効かない（X-72）", () => {
    const both = withLines(OVERLAP_BU, line("O100_1RO", 1, [FIRST]));
    const a = withFacility(both, "revisitBaseUpSameDay", yes);
    expect(tags(a, "R08", "R15")).toEqual(["R15:情報不足:facility.revisitPriceSameDay"]);
    const b = withFacility(both, "revisitPriceSameDay", yes);
    expect(tags(b, "R08", "R15")).toEqual(["R08:情報不足:facility.revisitBaseUpSameDay"]);
  });
});

// ---------------------------------------------------------------------------
// R10：算定した行だけで判定する（§2-3-4 の A〜D）

describe("R10 往診と訪問診療の同日・翌日", () => {
  const events2 = (c: ClaimContext) => withEvents(c, { type: "oushin", date: FIRST, kind: "normal" });
  const noEvents = (c: ClaimContext): ClaimContext => ({ ...c, events: c.events.filter((e) => e.type !== "visit" && e.type !== "oushin") });

  it("A：同じ日に両方の行があり、別々の診療かを確かめていない → 情報不足（出来事が 2 つあっても、1 つもなくても同じ）", () => {
    for (const c of [events2(K1_BOTH), noEvents(K1_BOTH)]) {
      const f = of(c, "R10");
      expect(f).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "sameDaySeparate", date: FIRST } })]);
    }
  });
  it("B：別々の診療でないと確かめた → 背反 same_encounter（往診料と、その日の訪問診療料の両方を指す）", () => {
    const f = of(separate(K1_BOTH, { [FIRST]: false }), "R10");
    expect(f.map((x) => [x.kind, x.messageKey, x.lineRefs])).toEqual([["背反", "R10.same_encounter", ["C000", "C001_1I"]]]);
  });
  it("C：別々の診療と確かめた同じ日。在支診で文書提供済みなら通す、なしなら要件不足、不明なら情報不足", () => {
    const c = separate(K1_BOTH, { [FIRST]: true });
    expect(tags(c, "R10")).toEqual([]);
    const ng = of(withFact(c, "contactDocProvided", no), "R10");
    expect(ng.map((x) => [x.kind, x.messageKey, x.lineRefs])).toEqual([["要件不足", "R10.same_day_as_visit", ["C001_1I"]]]);
    expect(of(withFact(c, "contactDocProvided", unknown), "R10")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "contactDocProvided" } })]);
  });
  it("D：往診料の翌日の訪問診療料。文書提供の 3 通り。在支診でなければ要件不足", () => {
    expect(tags(K1_DAY_AFTER, "R10")).toEqual([]);
    const ng = of(withFact(K1_DAY_AFTER, "contactDocProvided", no), "R10");
    expect(ng.map((x) => [x.kind, x.messageKey, x.lineRefs])).toEqual([["要件不足", "R10.visit_day_after_oushin", ["C001_1I"]]]);
    expect(tags(withFact(K1_DAY_AFTER, "contactDocProvided", unknown), "R10")).toEqual(["R10:情報不足:contactDocProvided"]);
    expect(tags({ ...K1_DAY_AFTER, facility: { ...K1_DAY_AFTER.facility, zaishishin: false } }, "R10")).toEqual(["R10:要件不足:visit_day_after_oushin"]);
  });
  it("両方の出来事があっても、片方だけ算定していれば 0 件", () => {
    expect(tags(events2(K1), "R10")).toEqual([]);
    expect(evaluate(events2(K1)).applied).not.toContain("R10");
  });
  it("答えのある日とない日が混ざると、ない日の分だけが情報不足になり、missing.date がその日になる（C-77 (a)）", () => {
    const c = separate(setDates(K1_BOTH, "C000", [FIRST, SECOND]), { [FIRST]: true });
    const f = of(c, "R10");
    expect(f).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "sameDaySeparate", date: SECOND } })]);
    // 2 日とも答えがなければ、日付の違う 2 件
    expect(of(separate(c, {}), "R10").map((x) => x.missing?.date)).toEqual([FIRST, SECOND]);
  });
  it("緊急往診加算の対象外は要件不足。対象かどうかが不明なら情報不足", () => {
    const c = withLines(K1_OUSHIN, line("C000_N1_KINKYU", 1, [OTHER]));
    expect(tags(c, "R10")).toEqual([]);
    expect(tags(withFact(c, "emergencyEligible", no), "R10")).toEqual(["R10:要件不足:kinkyu_not_eligible"]);
    expect(tags(withFact(c, "emergencyEligible", unknown), "R10")).toEqual(["R10:情報不足:emergencyEligible"]);
  });
});

// ---------------------------------------------------------------------------

describe("R11 外来迅速検体検査加算（算定できないとは断定しない。EM #7-9・#7-10）", () => {
  const RAPID = withLines(K1, line("D_GAIRAI_JINSOKU", 4, [FIRST]));
  it("訪問診療料の日の加算は、当日中の説明と文書提供の記録で決まる：はい → 通す／いいえ → 要件不足／不明 → 情報不足", () => {
    expect(tags(withFact(RAPID, "rapidSameDayDocumented", yes), "R11")).toEqual([]);
    expect(tags(withFact(RAPID, "rapidSameDayDocumented", no), "R11")).toEqual(["R11:要件不足:rapid_needs_same_day_doc"]);
    expect(of(withFact(RAPID, "rapidSameDayDocumented", unknown), "R11")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "rapidSameDayDocumented" } })]);
  });
  it("訪問診療料も往診料もない日（外来）の加算には、何も聞かない", () => {
    expect(tags(withFact(withLines(K6, line("D_GAIRAI_JINSOKU", 1, [FIRST])), "rapidSameDayDocumented", unknown), "R11")).toEqual([]);
  });
  it("判断料が同じ区分で月 2 回は背反", () => {
    expect(tags(setDates(K1, "D026_4", [FIRST, SECOND]), "R11")).toEqual(["R11:背反:judgement_once_a_month"]);
  });
});

describe("R12 在宅医療DX情報活用加算の区分と届出", () => {
  it("届出が加算1 なのに加算2 の区分 → dx_tier", () => {
    expect(tags(replaceKubun(K1, "C001_N13_DX", "C001_N13_DX2"), "R12")).toEqual(["R12:区分誤り:dx_tier"]);
    expect(tags(withFacility(replaceKubun(K1, "C001_N13_DX", "C001_N13_DX2"), "dxTier", { known: true, value: "2" }), "R12")).toEqual([]);
  });
  it("届出なしで加算 → dx_not_notified。届出の区分が不明なら情報不足（clerk, facility.dxTier）", () => {
    expect(tags(withFacility(K1, "dxTier", { known: true, value: "なし" }), "R12")).toEqual(["R12:要件不足:dx_not_notified"]);
    expect(of(withFacility(K1, "dxTier", unknown), "R12")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "facility.dxTier" } })]);
  });
});

describe("R13 週 3 回（算定した行の日で数える）", () => {
  const ng = cases.find((c) => c.id === "R13")!.ng;
  it("別表第七なら週 4 回でも指摘しない。急性増悪かどうかが不明なら情報不足", () => {
    expect(kinds(withFact(ng, "table7", yes), "R13")).toEqual([]);
    expect(tags(withFact(ng, "acuteExacerbation", unknown), "R13")).toEqual(["R13:情報不足:acuteExacerbation"]);
  });
  it("別表第七に当たると分かっていれば、急性増悪が不明でも確認を出さない（C-81）", () => {
    expect(tags(withFact(withFact(ng, "table7", yes), "acuteExacerbation", unknown), "R13")).toEqual([]);
  });
  it("訪問の出来事があっても、訪問診療料を算定しなかった日は数えない（C-65）", () => {
    const c = withEvents(K1, ...[12, 13, 15].map((n) => ({ type: "visit" as const, date: day(n), sameBuildingCount: 1 })));
    expect(kinds(c, "R13")).toEqual([]);
  });
});

describe("R16 管理料の族", () => {
  it("居宅の患者に施設総管 → use_zaii。居住の場所が不明なら情報不足（clerk）", () => {
    expect(tags(replaceKubun(K2, "C002_2RO1", "C002-2_2RO1"), "R16")).toEqual(["R16:区分誤り:use_zaii"]);
    expect(of(withFact(K4, "residence", unknown), "R16")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "residence" } })]);
  });
});

describe("R09 ターミナルケア加算の回数：同じ日の訪問診療と往診（X-73）", () => {
  const D = day(21);
  const DEATH = day(22);
  /** 21 日に訪問診療と往診の出来事、22 日に在宅で死亡。ほかの訪問はない */
  const ONE_DAY: ClaimContext = {
    ...loadCase("K5"),
    events: [
      { type: "visit", date: D, sameBuildingCount: 1 },
      { type: "oushin", date: D, kind: "normal" },
      { type: "death", date: DEATH },
    ],
    lines: [line("C001_1I", 1, [D]), line("C001_N6_TERMINAL", 1, [DEATH])],
  };
  it("別々の診療でないと確かめた日は 1 回と数える（2 回に届かず要件不足）", () => {
    expect(tags(separate(ONE_DAY, { [D]: false }), "R09")).toEqual(["R09:要件不足:terminal_visits"]);
  });
  it("別々の診療と確かめた日は 2 回と数える", () => {
    expect(tags(separate(ONE_DAY, { [D]: true }), "R09")).toEqual([]);
  });
  it("確かめていない日で回数が決まらないときは、その日つきの情報不足（医療事務）", () => {
    expect(of(ONE_DAY, "R09")).toEqual([expect.objectContaining({ kind: "情報不足", lineRefs: ["C001_N6_TERMINAL"], missing: { target: "clerk", field: "sameDaySeparate", date: D } })]);
    expect(of(withFact(ONE_DAY, "sameDaySeparate", unknown), "R09")).toHaveLength(1);
  });
  it("ほかの日の訪問で 2 回に届いていれば、確かめていない日があっても聞かない", () => {
    const c = withEvents(ONE_DAY, { type: "visit", date: day(19), sameBuildingCount: 1 });
    expect(tags(c, "R09")).toEqual([]);
    expect(tags(separate(c, { [D]: false }), "R09")).toEqual([]);
  });
});

describe("同じ区分を複数の行に分けた請求（X-75）", () => {
  /** 行を 1 日ずつの別の行に分ける */
  const split = (ctx: ClaimContext, kubun: string): ClaimContext => ({ ...ctx, lines: ctx.lines.flatMap((l) => (l.kubun === kubun ? l.dates.map((d) => ({ kubun, count: 1, dates: [d] })) : [l])) });
  it("R11：判断料を 14 日と 28 日の別の行で 1 回ずつ算定しても、月 1 回の背反が出る", () => {
    const c = withLines(K2, line("D026_3", 1, [SECOND]));
    expect(tags(c, "R11")).toEqual(["R11:背反:judgement_once_a_month"]);
    expect(of(c, "R11")[0].lineRefs).toEqual(["D026_3"]);
  });
  it("R08・R15：2 行目にある往診料だけの日も、訪問診療時の区分の誤りとして出る", () => {
    const r08 = split(setDates(K1_OUSHIN, "O001_3I", [FIRST, SECOND, OTHER]), "O001_3I");
    expect(tags(r08, "R08")).toEqual(["R08:区分誤り:oushin_only_day"]);
    const r15 = split(setDates(K1_OUSHIN, "O100_1HA", [FIRST, SECOND, OTHER]), "O100_1HA");
    expect(tags(r15, "R15")).toEqual(["R15:区分誤り:oushin_only_day"]);
  });
  it("分けても束ねても、指摘と合計は同じ。行ごとの点数は渡された行のまま", () => {
    for (const k of ["C001_1I", "O001_3I", "O100_1HA"]) {
      const s = evaluate(split(K1, k));
      expect(s.findings).toEqual(evaluate(K1).findings);
      expect(s.total).toBe(evaluate(K1).total);
      expect(s.byLine).toHaveLength(K1.lines.length + 1);
    }
  });
});

describe("R07 処方箋料の区分は処方ごとに判定する（X-77）", () => {
  const A = day(1);
  const B = day(20);
  /** 管理料のない月。1 日に内服 5 種類、20 日に 7 種類の処方 */
  const base = (...lines: ReturnType<typeof line>[]): ClaimContext => ({
    ...without(NO_KANRI, "F400_3", "F400_N4", "F400_N6_1"),
    events: [...NO_KANRI.events.filter((e) => e.type !== "prescription"), { type: "prescription", date: A, oralKinds: 5, days: 14 }, { type: "prescription", date: B, oralKinds: 7, days: 14 }],
    lines: [...without(NO_KANRI, "F400_3", "F400_N4", "F400_N6_1").lines, ...lines],
  });
  it("処方ごとに合う区分なら指摘なし", () => {
    expect(tags(base(line("F400_3", 1, [A]), line("F400_2", 1, [B])), "R07")).toEqual([]);
  });
  it("7 種類以上の処方の日を区分 3 にすると use_seven_or_more、未満の処方の日を区分 2 にすると not_seven_or_more", () => {
    expect(tags(base(line("F400_3", 2, [A, B])), "R07")).toEqual(["R07:区分誤り:use_seven_or_more"]);
    expect(tags(base(line("F400_2", 2, [A, B])), "R07")).toEqual(["R07:区分誤り:not_seven_or_more"]);
    expect(tags(base(line("F400_2", 1, [A]), line("F400_3", 1, [B])), "R07")).toEqual(["R07:区分誤り:use_seven_or_more", "R07:区分誤り:not_seven_or_more"]);
  });
  it("行の日に処方の出来事がないときは、月の処方のどれかに合えば指摘しない（日付で対応がとれないときの仮置き）", () => {
    expect(tags(base(line("F400_3", 1, [day(2)]), line("F400_2", 1, [day(21)])), "R07")).toEqual([]);
  });
});

describe("未知の区分", () => {
  it("例外を投げる（0 点にしない）。前の年度だけの区分も、この版にはない", () => {
    expect(() => evaluate(withLines(K1, line("XXXX")))).toThrow();
    expect(() => evaluate(withLines(K1, line("O100_3I")))).toThrow();
  });
});
