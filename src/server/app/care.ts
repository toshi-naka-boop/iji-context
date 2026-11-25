// 介護保険・ほかの医療機関との調整の申告（design.md §18-2。v37 21b）：入所先の施設（院内の設定）、患者の介護の申告、ほかの機関の行と「ないと確かめた」。
// どれも追記だけ。答えの月は、開いた UKE の診療年月（C-513。今日の月ではない）。確かめた人はセッションの本人、確かめた日と出どころは必須。
// 判定に渡す形（src/engine/care.ts の CareFacts・OtherFacts）もここで作る。値・機関名・施設名は、ログ・監査ログ・エラー文・AI に送る文脈に出さない
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monthRange, YEAR_MONTH } from "../../demo/period";
import {
  CARE_HOME_KINDS,
  CARE_SOURCES,
  KANRI_SIDES,
  NURSE_INSURANCES,
  OTHER_ACTIVITIES,
  OTHER_KINDS,
  RESIDENCE_TYPES,
  SHORT_STAY_KINDS,
  TRI,
  residenceOfType,
  type Basis,
  type CareFacts,
  type CareHomeFacts,
  type CareHomeKind,
  type CareSource,
  type OtherActivity,
  type OtherFacts,
  type OtherRow,
  type ResidenceType,
  type ShortStayKind,
  type Tri,
} from "../../engine/care";
import type { Fact } from "../../engine/types";
import { addMonthsTo, certifiedOf, type CareState } from "../../patient/facts";
import { badRequest } from "../errors";
import { isRealDate } from "../../engine/rules/util";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

/** 設計パラメータ（config/care.json） */
export type CareConfig = { otherNoneMonths: number; staleMonths: number };
let cached: CareConfig | undefined;
export function careConfig(): CareConfig {
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), "config", "care.json"), "utf8")) as CareConfig;
  return cached;
}

export const CARE_ITEMS = ["residenceType", "shortStay", "nurseInsurance"] as const;
export type CareItem = (typeof CARE_ITEMS)[number];

/** 申告の値（patient_care.value の JSON） */
export type ResidenceValue = { type: ResidenceType; careHomeId?: string | null; changedMidMonth?: boolean };
export type ShortStayUseValue = { kind: ShortStayKind; start?: string | null; end?: string | null; careHomeId?: string | null; fromDischarge?: Tri };
export type ShortStayValue = { status: "使った" | "使っていない" | "分からない"; uses?: ShortStayUseValue[] };
export type NurseValue = { value: (typeof NURSE_INSURANCES)[number] };
export type CareValue = ResidenceValue | ShortStayValue | NurseValue;

export type CareInput = { item: CareItem; value: CareValue; checkedOn: string; source: CareSource };
export type CareRow = { seq: number; item: CareItem; fromMonth: string; value: CareValue; source: CareSource; checkedOn: string; checkedBy: string; enteredAt: string };

export type CareHomeInput = { homeId?: string; name: string; kind: CareHomeKind; placedPhysician: Tri; mitoriFacility: Tri; checkedOn: string; recheckOn: string; source: CareSource };
export type CareHome = Required<CareHomeInput> & { checkedBy: string; enteredAt: string };

export type OtherInput = {
  instId?: string;
  name: string;
  kind: (typeof OTHER_KINDS)[number];
  specialRelation: Tri;
  kanriSide: (typeof KANRI_SIDES)[number];
  activities: Partial<Record<OtherActivity, Tri>>;
  referredOn?: string | null;
  endMonth?: string | null;
  checkedOn: string;
  source: CareSource;
};
export type OtherInstitution = Required<Omit<OtherInput, "referredOn" | "endMonth">> & { referredOn: string | null; endMonth: string | null; fromMonth: string; checkedBy: string; seq: number };
export type OtherNone = { forMonth: string; checkedOn: string; source: CareSource; checkedBy: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME = 60;

const checkDate = (d: unknown, field: string, label: string) => {
  // 実在する日だけを通す（2026-10-00 などは、保存したあとの日付の計算で落ちる。round-82 X-390）
  if (typeof d !== "string" || !DATE.test(d) || !isRealDate(d)) throw badRequest(`${label}を実在する日付（YYYY-MM-DD）で入れてください`, [field]);
};
/** 読み込んだ日付：実在しない値（前の版で残ったものなど）は「ない」として扱い、読み込みを落とさない */
const readDate = (d: string | null | undefined): string | null => (d != null && isRealDate(d) ? d : null);
const checkBasis = (checkedOn: unknown, source: unknown) => {
  checkDate(checkedOn, "checkedOn", "確かめた日");
  if (!(CARE_SOURCES as readonly unknown[]).includes(source)) throw badRequest("出どころを選んでください", ["source"]);
};
const isTri = (v: unknown): v is Tri => (TRI as readonly unknown[]).includes(v);

/** 診療年月の中の行を、fromMonth が最大の行（同じ fromMonth なら後に残した行）で選ぶ */
const effectiveOf = <T extends { fromMonth: string; seq: number }>(rows: T[], yearMonth: string): T | undefined =>
  rows.filter((r) => r.fromMonth <= yearMonth).reduce<T | undefined>((best, r) => (!best || r.fromMonth > best.fromMonth || (r.fromMonth === best.fromMonth && r.seq > best.seq) ? r : best), undefined);

/** 確かめた日が古いか（診療年月の末日より staleMonths か月以上前。design.md §18-3） */
export function basisOf(checkedOn: string, source: CareSource, yearMonth: string): Basis & { staleMonths?: number } {
  const { staleMonths } = careConfig();
  const stale = checkedOn <= addMonthsTo(monthRange(yearMonth).end, -staleMonths);
  return { checkedOn, source, ...(stale ? { staleMonths } : {}) };
}

export function createCare(ctx: Pick<AppContext, "sqlite">, clock: Pick<Clock, "now">, clerks: Pick<Clerks, "clerk">) {
  const { sqlite } = ctx;

  // ---------------------------------------------------------------------------
  // 入所先の施設（院内の設定）

  function careHomes(): CareHome[] {
    const rows = sqlite.prepare("SELECT * FROM care_homes WHERE id IN (SELECT MAX(id) FROM care_homes GROUP BY home_id) ORDER BY id").all() as Record<string, string>[];
    return rows.map((r) => ({ homeId: r.home_id, name: r.name, kind: r.kind as CareHomeKind, placedPhysician: r.placed_physician as Tri, mitoriFacility: r.mitori_facility as Tri, checkedOn: r.checked_on, recheckOn: r.recheck_on, source: r.source as CareSource, checkedBy: r.checked_by, enteredAt: r.entered_at }));
  }
  const homeOf = (homeId: string | null | undefined): CareHome | null => (homeId ? (careHomes().find((h) => h.homeId === homeId) ?? null) : null);

  function saveCareHome(clerkId: string, input: CareHomeInput): CareHome[] {
    clerks.clerk(clerkId);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > MAX_NAME) throw badRequest(`施設の名前を ${MAX_NAME} 字以内で入れてください`, ["name"]);
    if (!(CARE_HOME_KINDS as readonly unknown[]).includes(input.kind)) throw badRequest("施設の種別を選んでください", ["kind"]);
    if (!isTri(input.placedPhysician)) throw badRequest("当院の医師がその施設の配置医師かを、はい・いいえ・分からないから選んでください", ["placedPhysician"]);
    if (!isTri(input.mitoriFacility)) throw badRequest("看取り介護加算の施設基準に合うかを、はい・いいえ・分からないから選んでください", ["mitoriFacility"]);
    checkBasis(input.checkedOn, input.source);
    checkDate(input.recheckOn, "recheckOn", "確かめ直す日");
    if (input.recheckOn < input.checkedOn) throw badRequest("確かめ直す日は、確かめた日より後にしてください", ["recheckOn"]);
    if (input.homeId !== undefined && homeOf(input.homeId) === null) throw badRequest("その施設はありません", ["homeId"]);
    const homeId = input.homeId ?? `H${randomUUID().slice(0, 8)}`;
    sqlite
      .prepare("INSERT INTO care_homes (home_id, name, kind, placed_physician, mitori_facility, source, checked_by, checked_on, recheck_on, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(homeId, name, input.kind, input.placedPhysician, input.mitoriFacility, input.source, clerkId, input.checkedOn, input.recheckOn, clock.now());
    return careHomes();
  }

  /** 判定に渡す施設の値（名前は渡さない）。看取り介護加算の値は、確かめ直す日が診療年月の末日より前なら「分からない」（判断 K） */
  function homeFactsOf(homeId: string | null | undefined, yearMonth: string): CareHomeFacts | null {
    const h = homeOf(homeId);
    if (!h) return null;
    return { kind: h.kind, placedPhysician: h.placedPhysician, mitoriFacility: h.recheckOn < monthRange(yearMonth).end ? "分からない" : h.mitoriFacility };
  }

  // ---------------------------------------------------------------------------
  // 患者の介護の申告

  function careRows(patientId: string): CareRow[] {
    const rows = sqlite.prepare("SELECT * FROM patient_care WHERE patient_id = ? ORDER BY id").all(patientId) as Record<string, string | number>[];
    return rows.map((r) => ({ seq: r.id as number, item: r.item as CareItem, fromMonth: r.from_month as string, value: JSON.parse(r.value as string) as CareValue, source: r.source as CareSource, checkedOn: r.checked_on as string, checkedBy: r.checked_by as string, enteredAt: r.entered_at as string }));
  }

  /** 診療年月に効く申告：続く状態（住まいの種別・訪問看護の保険）は fromMonth で選び、短期入所はその月の行だけ（次の月に引き継がない） */
  function effectiveCare(patientId: string, yearMonth: string): Partial<Record<CareItem, CareRow>> {
    const rows = careRows(patientId);
    const pick = (item: CareItem) => (item === "shortStay" ? rows.filter((r) => r.item === item && r.fromMonth === yearMonth).at(-1) : effectiveOf(rows.filter((r) => r.item === item), yearMonth));
    return Object.fromEntries(CARE_ITEMS.flatMap((i) => {
      const r = pick(i);
      return r ? [[i, r]] : [];
    }));
  }

  function checkCareValue(item: CareItem, value: CareValue, yearMonth: string): CareValue {
    if (typeof value !== "object" || value === null) throw badRequest("値の形が違います", ["value"]);
    if (item === "residenceType") {
      const v = value as ResidenceValue;
      if (!(RESIDENCE_TYPES as readonly unknown[]).includes(v.type)) throw badRequest("住まいの種別を選んでください", ["value.type"]);
      if (v.careHomeId != null) {
        if (v.type === "自宅" || v.type === "分からない") throw badRequest("入所先の施設は、施設の種別のときだけ付けます", ["value.careHomeId"]);
        if (homeOf(v.careHomeId) === null) throw badRequest("その施設はありません", ["value.careHomeId"]);
      }
      if (v.changedMidMonth !== undefined && typeof v.changedMidMonth !== "boolean") throw badRequest("月の途中で変わったかは、はい・いいえで入れてください", ["value.changedMidMonth"]);
      return { type: v.type, ...(v.careHomeId ? { careHomeId: v.careHomeId } : {}), ...(v.changedMidMonth ? { changedMidMonth: true } : {}) };
    }
    if (item === "shortStay") {
      const v = value as ShortStayValue;
      if (!["使った", "使っていない", "分からない"].includes(v.status)) throw badRequest("今月の短期入所を、使った・使っていないと確かめた・分からないから選んでください", ["value.status"]);
      const uses = v.uses ?? [];
      if (v.status !== "使った") {
        if (uses.length > 0) throw badRequest("使っていない・分からないには、利用を付けません", ["value.uses"]);
        return { status: v.status };
      }
      if (uses.length === 0) throw badRequest("使ったときは、利用を 1 つ以上入れてください", ["value.uses"]);
      const { start, end } = monthRange(yearMonth);
      return {
        status: "使った",
        uses: uses.map((u, i) => {
          if (!(SHORT_STAY_KINDS as readonly unknown[]).includes(u.kind)) throw badRequest("短期入所の種類を選んでください", [`value.uses.${i}.kind`]);
          if (u.start != null) {
            checkDate(u.start, `value.uses.${i}.start`, "開始日");
            if (u.start > end) throw badRequest("開始日は、この月の末日までにしてください", [`value.uses.${i}.start`]);
          }
          if (u.end != null) {
            checkDate(u.end, `value.uses.${i}.end`, "終了日");
            if (u.end < start || u.end > end) throw badRequest("終了日は、この月の中の日にしてください", [`value.uses.${i}.end`]);
            if (u.start != null && u.start > u.end) throw badRequest("開始日が、終了日より後になっています", [`value.uses.${i}.start`]);
          }
          if (u.careHomeId != null && homeOf(u.careHomeId) === null) throw badRequest("その施設はありません", [`value.uses.${i}.careHomeId`]);
          if (u.fromDischarge !== undefined && !isTri(u.fromDischarge)) throw badRequest("退院日から利用を始めたかを、はい・いいえ・分からないから選んでください", [`value.uses.${i}.fromDischarge`]);
          return { kind: u.kind, start: u.start ?? null, end: u.end ?? null, careHomeId: u.careHomeId ?? null, fromDischarge: u.fromDischarge ?? "分からない" };
        }),
      };
    }
    const v = value as NurseValue;
    if (!(NURSE_INSURANCES as readonly unknown[]).includes(v.value)) throw badRequest("訪問看護の保険を選んでください", ["value.value"]);
    return { value: v.value };
  }

  /** 申告を 1 行足す。fromMonth は開いた請求の診療年月（C-513） */
  function saveCare(patientId: string, yearMonth: string, clerkId: string, input: CareInput): { saved: true } {
    clerks.clerk(clerkId);
    if (!(CARE_ITEMS as readonly unknown[]).includes(input.item)) throw badRequest("項目が違います", ["item"]);
    if (!YEAR_MONTH.test(yearMonth)) throw badRequest("診療年月が違います", ["yearMonth"]);
    checkBasis(input.checkedOn, input.source);
    const value = checkCareValue(input.item, input.value, yearMonth);
    sqlite
      .prepare("INSERT INTO patient_care (patient_id, item, from_month, value, source, checked_by, checked_on, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, input.item, yearMonth, JSON.stringify(value), input.source, clerkId, input.checkedOn, clock.now());
    return { saved: true };
  }

  // ---------------------------------------------------------------------------
  // ほかの機関

  function otherRows(patientId: string): OtherInstitution[] {
    const rows = sqlite.prepare("SELECT * FROM other_institutions WHERE patient_id = ? ORDER BY id").all(patientId) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      seq: r.id as number,
      instId: r.inst_id as string,
      name: r.name as string,
      kind: r.kind as OtherInput["kind"],
      specialRelation: r.special_relation as Tri,
      kanriSide: r.kanri_side as OtherInput["kanriSide"],
      activities: JSON.parse(r.activities as string) as OtherInput["activities"],
      referredOn: (r.referred_on as string | null) ?? null,
      fromMonth: r.from_month as string,
      endMonth: (r.end_month as string | null) ?? null,
      checkedOn: r.checked_on as string,
      source: r.source as CareSource,
      checkedBy: r.checked_by as string,
    }));
  }
  function noneRows(patientId: string): OtherNone[] {
    return (sqlite.prepare("SELECT for_month, checked_on, source, checked_by FROM other_institutions_none WHERE patient_id = ? ORDER BY id").all(patientId) as Record<string, string>[]).map((r) => ({ forMonth: r.for_month, checkedOn: r.checked_on, source: r.source as CareSource, checkedBy: r.checked_by }));
  }

  /** 診療年月に効く ほかの機関の行（機関ごとに fromMonth で選び、endMonth を過ぎたものは除く）と、効いている「ないと確かめた」（forMonth から otherNoneMonths か月。X-354） */
  function effectiveOthers(patientId: string, yearMonth: string): { rows: OtherInstitution[]; none: OtherNone | null } {
    const all = otherRows(patientId);
    const rows = [...new Set(all.map((r) => r.instId))].flatMap((id) => {
      const r = effectiveOf(all.filter((x) => x.instId === id), yearMonth);
      return r && (r.endMonth === null || r.endMonth >= yearMonth) ? [r] : [];
    });
    const months = careConfig().otherNoneMonths;
    const none = noneRows(patientId).filter((n) => n.forMonth <= yearMonth && yearMonth <= addMonthsTo(`${n.forMonth}-01`, months - 1).slice(0, 7)).at(-1) ?? null;
    return { rows, none };
  }

  function saveOther(patientId: string, yearMonth: string, clerkId: string, input: OtherInput): { saved: true; instId: string } {
    clerks.clerk(clerkId);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > MAX_NAME) throw badRequest(`機関の名前を ${MAX_NAME} 字以内で入れてください`, ["name"]);
    if (!(OTHER_KINDS as readonly unknown[]).includes(input.kind)) throw badRequest("機関の種別を選んでください", ["kind"]);
    if (!isTri(input.specialRelation)) throw badRequest("特別の関係かを、はい・いいえ・分からないから選んでください", ["specialRelation"]);
    if (!(KANRI_SIDES as readonly unknown[]).includes(input.kanriSide)) throw badRequest("在医総管を取る側を選んでください", ["kanriSide"]);
    const activities = input.activities ?? {};
    for (const [k, v] of Object.entries(activities)) if (!(OTHER_ACTIVITIES as readonly string[]).includes(k) || !isTri(v)) throw badRequest("その機関がしていることは、項目ごとに している・していない・分からない（はい・いいえ・分からない）で入れてください", ["activities"]);
    if (input.referredOn != null) checkDate(input.referredOn, "referredOn", "求めた日");
    if (input.endMonth != null && (!YEAR_MONTH.test(input.endMonth) || input.endMonth < yearMonth)) throw badRequest("終わった月は YYYY-MM で、この診療年月以後にしてください", ["endMonth"]);
    checkBasis(input.checkedOn, input.source);
    if (input.instId !== undefined && !otherRows(patientId).some((r) => r.instId === input.instId)) throw badRequest("その機関の行はありません", ["instId"]);
    const instId = input.instId ?? `I${randomUUID().slice(0, 8)}`;
    // 訂正（instId あり）で送られなかった項目は、その機関の今の値のまま残す（終わった月・求めた日・していることの項目。round-84 X-412）
    // 引き継ぐ値は、訂正する月に効いていた行（その月以前の最新の行）から取る（後の月に残した行から取らない。X-422）
    const cur = input.instId !== undefined ? effectiveOf(otherRows(patientId).filter((r) => r.instId === input.instId), yearMonth) : undefined;
    const endMonth = input.endMonth !== undefined ? input.endMonth : (cur?.endMonth ?? null);
    const referredOn = input.referredOn !== undefined ? input.referredOn : (cur?.referredOn ?? null);
    const merged = { ...(cur?.activities ?? {}), ...activities };
    sqlite
      .prepare("INSERT INTO other_institutions (patient_id, inst_id, name, kind, special_relation, kanri_side, activities, referred_on, from_month, end_month, source, checked_by, checked_on, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, instId, name, input.kind, input.specialRelation, input.kanriSide, JSON.stringify(merged), referredOn, yearMonth, endMonth, input.source, clerkId, input.checkedOn, clock.now());
    return { saved: true, instId };
  }

  function saveOtherNone(patientId: string, yearMonth: string, clerkId: string, input: { checkedOn: string; source: CareSource }): { saved: true } {
    clerks.clerk(clerkId);
    checkBasis(input.checkedOn, input.source);
    sqlite.prepare("INSERT INTO other_institutions_none (patient_id, for_month, source, checked_by, checked_on, entered_at) VALUES (?, ?, ?, ?, ?, ?)").run(patientId, yearMonth, input.source, clerkId, input.checkedOn, clock.now());
    return { saved: true };
  }

  // ---------------------------------------------------------------------------
  // 判定に渡す形

  /** 住まいの種別の事実（診療年月に効く行。なければ undefined＝申告なし） */
  function residenceTypeOf(patientId: string, yearMonth: string): { fact: Fact<ResidenceType>; row: CareRow } | undefined {
    const row = effectiveCare(patientId, yearMonth).residenceType;
    if (!row) return undefined;
    const t = (row.value as ResidenceValue).type;
    return { fact: t === "分からない" ? { known: false } : { known: true, value: t }, row };
  }

  /**
   * 請求の文脈に足す介護の申告（design.md §18-3）。cert は要介護・要支援の認定（careCert）。priorVisitOf は、短期入所の開始日から利用前 30 日の当院の訪問の有無（呼び出し側が当院の請求から導く）。
   * 短期入所を聞かない患者（認定がないと確かめた・施設の入所者。C-493）は、申告がなくても「使っていない」と読む（derived）
   */
  function careFactsOf(patientId: string, yearMonth: string, cert: CareState, priorVisitOf: (start: string | null) => boolean | null): CareFacts {
    const eff = effectiveCare(patientId, yearMonth);
    const out: CareFacts = {};
    const certified = certifiedOf(cert);
    out.certified = certified.known && cert.known ? { known: true, value: certified.value, checkedOn: cert.checkedAt.slice(0, 10), source: cert.source } : { known: false };
    if (eff.residenceType) {
      const v = eff.residenceType.value as ResidenceValue;
      out.residence = { type: v.type, changedMidMonth: v.changedMidMonth === true, home: homeFactsOf(v.careHomeId, yearMonth), ...basisOf(eff.residenceType.checkedOn, eff.residenceType.source, yearMonth) };
    }
    if (eff.shortStay) {
      const v = eff.shortStay.value as ShortStayValue;
      out.shortStay = {
        status: v.status,
        uses: (v.uses ?? []).map((u) => ({ kind: u.kind, start: readDate(u.start), end: readDate(u.end), home: homeFactsOf(u.careHomeId, yearMonth), fromDischarge: u.fromDischarge ?? "分からない", priorVisit: priorVisitOf(readDate(u.start)) })),
        ...basisOf(eff.shortStay.checkedOn, eff.shortStay.source, yearMonth),
      };
    } else if (!askShortStay(out)) {
      out.shortStay = { status: "使っていない", uses: [], derived: true };
    }
    return out;
  }

  /** ほかの機関の申告を判定に渡す形（機関名は渡さない） */
  function otherFactsOf(patientId: string, yearMonth: string): OtherFacts | undefined {
    const { rows, none } = effectiveOthers(patientId, yearMonth);
    if (rows.length === 0 && none === null) return undefined;
    return {
      rows: rows.map((r): OtherRow => ({ kind: r.kind, specialRelation: r.specialRelation, kanriSide: r.kanriSide, activities: r.activities, referredOn: readDate(r.referredOn), ...basisOf(r.checkedOn, r.source, yearMonth) })),
      none: none ? basisOf(none.checkedOn, none.source, yearMonth) : null,
    };
  }

  return { careHomes, saveCareHome, careRows, effectiveCare, saveCare, otherRows, noneRows, effectiveOthers, saveOther, saveOtherNone, residenceTypeOf, careFactsOf, otherFactsOf };
}

/**
 * 今月の短期入所を聞く患者か（design.md §18-5。C-493）：要介護・要支援の認定がある（効いている）患者で、住まいの種別が自宅・有料・サ高住のとき。
 * 認定が分からない・住まいの種別の申告がない・分からないときも聞く（決められないので聞く側に倒す）。認定がないと確かめた患者と、施設の入所者には聞かない
 */
export function askShortStay(care: Pick<CareFacts, "certified" | "residence">): boolean {
  if (care.certified?.known && care.certified.value === false) return false;
  const t = care.residence?.type;
  if (t === undefined || t === "分からない") return true;
  return t === "自宅" || t === "有料老人ホーム（特定施設の指定なし）" || t === "サ高住（特定施設の指定なし）" || t === "有料・サ高住で特定施設の指定か分からない";
}

/** 2 値の居住の場所（判定に渡す residence）を、住まいの種別から導く（design.md §18-2）。none（2 値に当たらない）と分からないは「分からない」 */
export function residenceFactOf(t: Fact<ResidenceType>): Fact<"居宅" | "施設入居等"> {
  if (!t.known) return { known: false };
  const r = residenceOfType(t.value);
  return r === "居宅" || r === "施設入居等" ? { known: true, value: r } : { known: false };
}

export type Care = ReturnType<typeof createCare>;
