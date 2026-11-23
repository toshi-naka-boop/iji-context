// 導出と検証が共有する述語（design.md §2-8・§2-3-3・§2-3-4）
import { addDays, eventsOf, fact } from "./rules/util";
import type { ByGrade, KanriFamily, KanriRow, KanriTierKey, RevisionConsts } from "./revisions/types";
import { NOTE14_BANDS, type BuildingBand, type ClaimContext, type Fact, type FacilityGrade } from "./types";

/** 版の管理料の区分をすべて（在医総管・施設総管の、種別×区分〔×人数〕の全部） */
export function kanriKubun(c: RevisionConsts): string[] {
  return c.kanri.rows.map((r) => r.kubun);
}

/** 管理料の区分のキーから、族・種別・区分（と人数の区分）を引く */
export function kanriOf(c: RevisionConsts, kubun: string): Omit<KanriRow, "kubun"> | undefined {
  const row = c.kanri.rows.find((r) => r.kubun === kubun);
  if (!row) return undefined;
  const { kubun: _, ...rest } = row;
  return rest;
}

/** 族×種別×区分×人数の区分の管理料の区分（人数の区分を省けば単一建物 1 人の区分）。その版にない組は undefined */
export function kanriKubunOf(c: RevisionConsts, family: KanriFamily, grade: FacilityGrade, tier: KanriTierKey, band: BuildingBand = "1"): string | undefined {
  return c.kanri.rows.find((r) => r.family === family && r.grade === grade && r.tier === tier && (r.band ?? "1") === band && r.note14 === undefined)?.kubun;
}

/** 通常の区分の、注14 の減の行（注14 だけの行と、在支診以外では注8 と重ねた行。design.md §15-4。X-171）。持たない区分・版は空 */
export const reducedOf = (c: RevisionConsts, normal: string): string[] => Object.entries(c.kanri.note14Pairs ?? {}).filter(([, n]) => n === normal).map(([k]) => k);

/** 管理料の行が 10 人以上の人数の区分か（通常の行・減の行とも） */
export const isNote14Band = (c: RevisionConsts, kubun: string): boolean => {
  const b = kanriBandOf(c, kubun);
  return b !== undefined && NOTE14_BANDS.includes(b);
};

/**
 * 請求の 10 人以上の管理料の注14 の側（design.md §15-4。round-57 X-172）：減の行があれば 減、通常の行があれば 通常、どちらもなければ なし。
 * 版に note14Pairs がなければ なし。算定プレビューは、日で絞る前・導出する区分を外す前の請求の全部の行から求めて導出に渡す（C-333）
 */
export function claimNote14SideOf(lines: { kubun: string; count: number }[], c: RevisionConsts): "減" | "通常" | "なし" {
  if (!c.kanri.note14Pairs) return "なし";
  const tenPlus = lines.filter((l) => l.count > 0 && isNote14Band(c, l.kubun));
  if (tenPlus.some((l) => c.kanri.rows.find((r) => r.kubun === l.kubun)?.note14 !== undefined)) return "減";
  return tenPlus.length ? "通常" : "なし";
}

/** 管理料の行の人数の区分（1 人の区分の行は "1"）。管理料の区分でなければ undefined */
export const kanriBandOf = (c: RevisionConsts, kubun: string): BuildingBand | undefined => {
  const row = c.kanri.rows.find((r) => r.kubun === kubun);
  return row ? (row.band ?? "1") : undefined;
};

/**
 * 単一建物診療患者の人数の区分の決め方（design.md §15-4。C-242）：施設の申告 building が「ない」→ どの患者も 1 人の区分（byDeclaration は、その値が施設の申告から来たか）。
 * 「ある」「分からない」→ 患者ごとの事実 buildingBand。効かなければ分からない（facilityFirst は building も分からないとき。施設の申告の画面への案内を先に出す）
 */
export type BandRead = { known: true; value: BuildingBand; byDeclaration: boolean } | { known: false; facilityFirst: boolean };
export function buildingBandOf(ctx: Pick<ClaimContext, "facility" | "facts" | "facilityBasis">): BandRead {
  const b = ctx.facility.building;
  if (b.known && b.value === "none") return { known: true, value: "1", byDeclaration: ctx.facilityBasis?.building === "declaration" };
  const f = ctx.facts.buildingBand;
  if (f?.known) return { known: true, value: f.value, byDeclaration: false };
  return { known: false, facilityFirst: !b.known };
}

/** 算定している管理料の行（回数 1 以上）を、族・種別・区分つきで */
export function kanriLines(ctx: ClaimContext, c: RevisionConsts): ({ kubun: string } & Omit<KanriRow, "kubun">)[] {
  return ctx.lines.flatMap((l) => {
    const k = l.count > 0 ? kanriOf(c, l.kubun) : undefined;
    return k ? [{ kubun: l.kubun, ...k }] : [];
  });
}

/**
 * 施設の種別で分かれる区分の表（design.md §15-4。R18 と derivedKubun・kubunFamily が引く 1 か所）：
 * kubun → 種別と、種別だけが違う区分を同じにする鍵（slot）。管理料は族×区分（×人数）、在宅ターミナルケア加算・緊急往診加算はそれぞれ 1 つ
 */
export function gradeSlots(c: RevisionConsts): { kubun: string; grade: FacilityGrade; slot: string }[] {
  const byGrade = (slot: string, t: ByGrade) => (Object.entries(t) as [FacilityGrade, string][]).map(([grade, kubun]) => ({ kubun, grade, slot }));
  return [
    ...c.kanri.rows.map((r) => ({ kubun: r.kubun, grade: r.grade, slot: `${r.family}/${r.tier}/${r.band ?? ""}/${r.note14 ?? ""}` })),
    ...byGrade("在宅ターミナルケア加算", c.terminal.terminal),
    ...byGrade("緊急往診加算", c.oushin.kinkyu),
  ];
}

/**
 * 同じ族の表（design.md §15-8。round-51 C-250）：kubun → 族の名前。区分誤りの直し先が同じ族なら、G11 は取り忘れを抑えない（段 18b が使う）。
 * 族は、在医総管・施設総管（それぞれ種別×区分×人数を通して 1 族）、緊急往診加算・在宅ターミナルケア加算（それぞれ種別の区分）、
 * ベースアップ評価料(Ⅰ)（R08 の訪問診療時・再診時等と、同じ区分の通常・注5）と、その初診時（通常・注5）。gradeSlots と版の定数から作り、手で並べない
 */
export function kubunFamily(c: RevisionConsts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of c.kanri.rows) out[r.kubun] = r.family;
  for (const k of Object.values(c.terminal.terminal)) out[k] = "在宅ターミナルケア加算";
  for (const k of Object.values(c.oushin.kinkyu)) out[k] = "緊急往診加算";
  const dayType = [...c.baseUp.visit, c.baseUp.revisit];
  for (const k of dayType) out[k] = "ベースアップ評価料(Ⅰ)";
  for (const [normal, note5] of Object.entries(c.baseUp.note5 ?? {})) {
    const family = dayType.includes(normal) ? "ベースアップ評価料(Ⅰ)" : `ベースアップ評価料(Ⅰ) ${normal}`;
    out[normal] = family;
    out[note5] = family;
  }
  return out;
}

/** ベースアップ評価料(Ⅰ) の、R08 が見る訪問診療時と再診時等の区分（通常と注5）。注5 の表を持たない版は通常だけ */
export function baseUpDayKubun(c: RevisionConsts): { visit: string[]; revisit: string[] } {
  const n5 = c.baseUp.note5 ?? {};
  const withN5 = (ks: string[]) => [...ks, ...ks.flatMap((k) => (n5[k] ? [n5[k]] : []))];
  return { visit: withN5(c.baseUp.visit), revisit: withN5([c.baseUp.revisit]) };
}

/** 行の日付（回数 1 以上の行だけ）。重複は除いて昇順 */
export function billedDays(ctx: ClaimContext, kubuns: string[]): string[] {
  const days = ctx.lines.filter((l) => l.count > 0 && kubuns.includes(l.kubun)).flatMap((l) => l.dates);
  return [...new Set(days)].sort();
}

/** 訪問診療料を算定した日 */
export function billedVisitDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  return billedDays(ctx, c.visitKubun);
}

/** 往診料を算定した日 */
export function billedOushinDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  return billedDays(ctx, [c.oushin.kubun]);
}

/** 往診料だけを算定した日（訪問診療料を算定していない日） */
export function oushinOnlyBilledDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  const v = new Set(billedVisitDays(ctx, c));
  return billedOushinDays(ctx, c).filter((d) => !v.has(d));
}

/** 訪問診療料と往診料の両方を算定した日 */
export function sameDayPairs(ctx: ClaimContext, c: RevisionConsts): string[] {
  const o = new Set(billedOushinDays(ctx, c));
  return billedVisitDays(ctx, c).filter((d) => o.has(d));
}

/** その日に算定している訪問診療料の区分 */
export function visitKubunOn(ctx: ClaimContext, c: RevisionConsts, day: string): string[] {
  return c.visitKubun.filter((k) => ctx.lines.some((l) => l.kubun === k && l.count > 0 && l.dates.includes(day)));
}

/** 算定した訪問診療の回数（訪問診療料の行の回数） */
export function visitCount(ctx: ClaimContext, c: RevisionConsts): number {
  return ctx.lines.filter((l) => c.visitKubun.includes(l.kubun)).reduce((s, l) => s + l.count, 0);
}

/** none＝その月は管理料を算定できない */
export type KanriTier = "none" | KanriTierKey;
export type KanriExpect = {
  /** 訪問診療料の行の回数 */
  visits: number;
  /** 居住の場所から決まる族。不明なら known:false */
  family: Fact<KanriFamily>;
  /** 施設の種別（施設の申告から。facility.grade）。区分（tier）の決め方には使わない */
  grade: Fact<FacilityGrade>;
  tier: { known: true; value: KanriTier } | { known: false; need: "table8_2" | "facility.note16Met"; candidates: KanriTier[] };
};

/**
 * 管理料の期待される族・種別・区分（§2-3-3・§15-4）。R01・R02・R03・R16 と導出の D03 が同じ答えを使う。区分の決め方は種別によらない。
 * 区分を決める順は 回数 → 重症 → 注16。不明な事実を聞くのは、その答えで区分が変わるときだけ。
 * 注16 のない版（note16.enabled が偽）では、施設の設定を読まず、月 2 回以上は 2ロ（design.md §11-2）
 */
export function expectedKanri(ctx: ClaimContext, c: RevisionConsts): KanriExpect {
  const visits = visitCount(ctx, c);
  const res = ctx.facts.residence;
  const family: Fact<KanriFamily> = res.known ? { known: true, value: c.kanri.familyOf[res.value] } : { known: false };
  const { enabled, from, to } = c.kanri.note16;
  const tier = ((): KanriExpect["tier"] => {
    if (visits === 0) return { known: true, value: "none" };
    if (visits === 1) return { known: true, value: "ニ" };
    const severe = ctx.facts.table8_2;
    if (!severe.known) return { known: false, need: "table8_2", candidates: ["イ", "ロ", "ニ"] };
    if (severe.value) return { known: true, value: "イ" };
    if (!enabled) return { known: true, value: "ロ" };
    const met = ctx.facility.note16Met;
    if (!met.known) return { known: false, need: "facility.note16Met", candidates: [from, to] };
    return { known: true, value: met.value ? from : to };
  })();
  return { visits, family, grade: ctx.facility.grade, tier };
}

/** 包括的支援加算を見る月か（期待される区分が加算の対象の区分。注16 だけが未定のときは、どちらの候補も対象なので見る） */
export function hokatsuInScope(ctx: ClaimContext, c: RevisionConsts): boolean {
  const t = expectedKanri(ctx, c).tier;
  const tiers: KanriTier[] = c.hokatsu.tiers;
  return t.known === true ? tiers.includes(t.value) : t.need === "facility.note16Met" && t.candidates.every((x) => tiers.includes(x));
}

/**
 * 包括的支援加算の対象か（別表第八の三。EM R8-15a）。R03 と導出の D04 が同じ答えを使う。
 * 要介護度が下限以上か、障害支援区分が下限以上か、ほかの状態に当たれば対象。どれにも当たらないと分かっていれば対象外。
 * 決まらないときは、次に確かめる事実を 1 つ返す（要介護度 → 障害支援区分 → ほかの状態 の順。答えで結果が変わらないことは聞かない。design.md §11-4 の表）
 */
export function hokatsuEligible(
  ctx: ClaimContext,
  c: RevisionConsts,
): { known: true; value: boolean } | { known: false; need: "careLevel" | "disabilitySupportLevel" | "table8_3Other" } {
  const care = ctx.facts.careLevel;
  const disability = ctx.facts.disabilitySupportLevel;
  const other = ctx.facts.table8_3Other;
  if ((care.known && care.value >= c.hokatsu.careLevelMin) || (disability.known && disability.value >= c.hokatsu.disabilityLevelMin) || (other.known && other.value))
    return { known: true, value: true };
  if (!care.known) return { known: false, need: "careLevel" };
  if (!disability.known) return { known: false, need: "disabilitySupportLevel" };
  if (!other.known) return { known: false, need: "table8_3Other" };
  return { known: true, value: false };
}

/**
 * 往診料を算定した日・その翌日の訪問診療料を算定できるか（§2-3-4 の「制限の判定」）。
 * 在支診で文書提供済みなら真、文書提供が不明なら "unknown"、それ以外は偽。施設の種別が分からない（zaishishin が null）ときも "unknown"
 * （聞く事実は facility.grade。visitBillableNeed）
 */
export function visitBillable(ctx: ClaimContext): boolean | "unknown" {
  if (ctx.facility.zaishishin === null) return "unknown";
  if (!ctx.facility.zaishishin) return false;
  const doc = ctx.facts.contactDocProvided;
  return doc.known ? doc.value : "unknown";
}

/** visitBillable が "unknown" のとき、聞く事実（種別が分からなければ施設の種別、分かれば連携先への文書提供） */
export const visitBillableNeed = (ctx: ClaimContext): "facility.grade" | "contactDocProvided" => (ctx.facility.zaishishin === null ? "facility.grade" : "contactDocProvided");

/** 日付ごとの事実の、その日の答え（載っていない日・事実が丸ごと不明なら undefined） */
const answerOn = (f: Fact<Record<string, boolean>>, day: string): boolean | undefined => (f.known ? f.value[day] : undefined);

/**
 * 同じ日の訪問診療と往診の関係（design.md §11-5）。R10 と導出の D01・D02 が同じ答えを使う。
 * same＝1 回の診療（sameDaySeparate が偽。訪問診療のあとの往診かは聞かずに偽として扱う）／
 * after＝訪問診療のあとに、急変などで往診した（sameDayOushinAfterVisit が真。別々の診療かは聞かずに真として扱う）／
 * not_after＝別々の診療だが、訪問診療のあとの往診ではない（往診が先、など。実施は 2 回だが、往診料は立てられない）。
 * 決まらないときは、次に確かめる事実を 1 つ返す。2 つの答えが食い違う日（1 回の診療で、かつ、あとの往診）は 1 回の診療として扱う。
 * 背反の特例条件の例外（G05。design.md §13-3）も同じ関数で読むので、読むのは事実だけ（facts）
 */
export function sameDayOf(ctx: Pick<ClaimContext, "facts">, day: string): { known: true; value: "same" | "after" | "not_after" } | { known: false; need: "sameDayOushinAfterVisit" | "sameDaySeparate" } {
  const separate = answerOn(ctx.facts.sameDaySeparate, day);
  const after = answerOn(ctx.facts.sameDayOushinAfterVisit, day);
  if (separate === false) return { known: true, value: "same" };
  if (after === true) return { known: true, value: "after" };
  if (after === undefined) return { known: false, need: "sameDayOushinAfterVisit" };
  if (separate === undefined) return { known: false, need: "sameDaySeparate" };
  return { known: true, value: "not_after" };
}

/** 同じ日の訪問診療と往診を、別々の診療（実施 2 回）と数えるか。sameDayOf と同じ関係で読み、決まらなければ undefined（確かめるのは sameDaySeparate） */
function separateOn(ctx: ClaimContext, day: string): boolean | undefined {
  const separate = answerOn(ctx.facts.sameDaySeparate, day);
  return separate === false ? false : answerOn(ctx.facts.sameDayOushinAfterVisit, day) === true ? true : separate;
}

/**
 * その日の処方箋料として期待される区分（design.md §11-5）。導出の D10 と R07 が同じ答えを使う。判定の単位は処方 1 回ごと（EM #7-13）。
 * 内服の種類数が閾値以上 → 区分 2（why: many）／閾値未満で向精神薬の長期処方 → 区分 2（long）／閾値未満で長期処方でない → 区分 3（other）。
 * 閾値未満で長期処方かが不明なら決まらない（rxLongPsychotropic を確かめる）。区分 3 のほうが点数が高いので、不明を区分 3 とみなさない（X-85）。
 * 処方に対象の薬が含まれないと分かっていれば（psychotropic が偽）、聞かずに長期処方でないとして扱う。null は「含まれない」とみなさない。
 * その日の処方の記録が 1 件に決まらないとき（ない＝行と対応がとれない／2 件以上＝日付ごとの事実では分けられない）も決まらない（rxRecord）。日付のない行は day を "" で渡す
 */
export function rxKubunOn(
  ctx: ClaimContext,
  c: RevisionConsts,
  day: string,
): { known: true; kubun: string; why: "many" | "long" | "other" } | { known: false; need: "rxRecord" | "rxLongPsychotropic" } {
  const onDay = eventsOf(ctx, "prescription").filter((e) => e.date === day);
  if (onDay.length !== 1) return { known: false, need: "rxRecord" };
  const e = onDay[0];
  if (e.oralKinds >= c.rx.oralKindsThreshold) return { known: true, kubun: c.rx.many, why: "many" };
  const long = e.psychotropic === false ? false : answerOn(ctx.facts.rxLongPsychotropic, day);
  if (long === undefined) return { known: false, need: "rxLongPsychotropic" };
  return long ? { known: true, kubun: c.rx.many, why: "long" } : { known: true, kubun: c.rx.other, why: "other" };
}

/**
 * ターミナルケア加算の訪問の回数の要件（死亡日前の所定の日数以内に、訪問診療・往診を所定の回数以上「実施」。出来事で数える）。死亡の出来事がなければ偽。
 * 同じ日の訪問診療と往診の出来事は、別々の診療でないと確かめた日（sameDaySeparate が偽）なら 1 回、別々の診療の日（往診が先でも）は 2 回と数える（X-73・C-88）。
 * 確かめていない日は 1 回とも出来事の数とも言えないので、どちらに数えても答えが同じときだけ決め、変わるときは "unknown" と、確かめる日（ask）を返す。
 * 別の経路（EM #7-11）：回数が足りなくても、退院時共同指導料1 を算定し、訪問診療を実施していれば満たす。
 * 退院時共同指導料1 を聞く（askGuidance）のは、回数が足りないと決まり、訪問診療が 1 回以上あるときだけ。
 * 死亡日の出来事は、死亡の前後を問わず数える（死亡後だけの診療を入れるかは未確認。要件不足を出さない側に倒れる。design.md L-49）。
 * 回数の要件（days・minVisits）を持たない版では呼ばない（例外。導出は呼ぶ前に確かめる）
 */
export function terminalVisitsOk(ctx: ClaimContext, c: RevisionConsts): { ok: boolean | "unknown"; ask: string[]; askGuidance: boolean } {
  const { days, minVisits } = c.terminal;
  if (days === undefined || minVisits === undefined) throw new Error("この版は、ターミナルケア加算の回数の要件を持たない");
  const death = eventsOf(ctx, "death")[0];
  if (!death) return { ok: false, ask: [], askGuidance: false };
  const from = addDays(death.date, -days);
  const done = [...eventsOf(ctx, "visit"), ...eventsOf(ctx, "oushin")].filter((e) => e.date >= from && e.date <= death.date);
  let min = 0;
  let max = 0;
  const ask: string[] = [];
  for (const d of [...new Set(done.map((e) => e.date))].sort()) {
    const types = done.filter((e) => e.date === d).map((e) => e.type);
    const both = types.includes("visit") && types.includes("oushin");
    const answer = both ? separateOn(ctx, d) : true;
    min += answer === true ? types.length : 1;
    max += answer === false ? 1 : types.length;
    if (answer === undefined) ask.push(d);
  }
  const guidance = ctx.facts.dischargeJointGuidance;
  const visited = done.some((e) => e.type === "visit");
  if (min >= minVisits || (visited && guidance.known && guidance.value)) return { ok: true, ask: [], askGuidance: false };
  if (max < minVisits) return visited && !guidance.known ? { ok: "unknown", ask: [], askGuidance: true } : { ok: false, ask: [], askGuidance: false };
  return { ok: "unknown", ask, askGuidance: false };
}

/** 週（始まりの日）ごとの、訪問診療料を算定した日（回数ぶん重ねる）。算定しなかった訪問は数えない */
function visitDaysByWeek(ctx: ClaimContext, c: RevisionConsts): Map<string, string[]> {
  const perWeek = new Map<string, string[]>();
  for (const l of ctx.lines) {
    if (l.count <= 0 || !c.visitKubun.includes(l.kubun)) continue;
    for (const date of l.dates) {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - c.weekStartsOn + 7) % 7));
      const key = d.toISOString().slice(0, 10);
      perWeek.set(key, [...(perWeek.get(key) ?? []), date]);
    }
  }
  return perWeek;
}

/** 週ごとの、訪問診療料を算定した回数の最大値 */
export function maxVisitsPerWeek(ctx: ClaimContext, c: RevisionConsts): number {
  return Math.max(0, ...[...visitDaysByWeek(ctx, c).values()].map((days) => days.length));
}

/** 週の上限を超えた週の、訪問診療料を算定した日（重複は除いて昇順）。R13 と同じ数え方で、R17 と導出の「摘要欄に書くこと」が使う */
export function overLimitVisitDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  const days = [...visitDaysByWeek(ctx, c).values()].filter((d) => d.length > c.weeklyVisitLimit).flat();
  return [...new Set(days)].sort();
}

/** "YYYY-MM" の差（月数） */
function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 在宅移行早期加算の対象か：退院後に在宅療養を始めた患者で、管理料の算定開始月から所定の月数以内・退院から所定の日数以内。
 * 再入院→再退院で数え直す例外は、退院イベントのうち最も新しいものを起点にすることで扱う
 */
export function ikouEligible(ctx: ClaimContext, c: RevisionConsts): boolean {
  const start = eventsOf(ctx, "kanriStart").map((e) => e.month).sort().at(-1);
  const discharge = eventsOf(ctx, "discharge").map((e) => e.date).sort().at(-1);
  if (!start || !discharge) return false;
  const months = monthDiff(start, ctx.yearMonth);
  // 算定開始月を 1 か月目として数える
  if (months < 0 || months > c.ikou.months - 1) return false;
  // 退院からの日数（請求月の初日で判定）
  return `${ctx.yearMonth}-01` <= addDays(discharge, c.ikou.daysFromDischarge);
}
