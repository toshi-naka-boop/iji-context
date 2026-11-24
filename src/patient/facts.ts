// 患者ごとに確かめた情報（要介護度・障害支援区分・別表第七・別表第八の二・別表第八の三のほかの状態・在宅酸素・居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者か）。
// 月をまたいで残る（design.md §6-1 の「単位：患者」の行）。その月・その日の出来事についての事実は、請求ごと（src/claim/facts.ts）に持つ。
// 判定はカルテ側の事実に、残した最新の値を重ねて使う。期限は今日ではなく診療年月で比べる（design.md §18-1。判断 A）：診療年月の全部の日に効く値だけを使い、月の途中で切れる・始まる値は「分からない」にする。
// 要介護・要支援の認定は careCert で持つ（design.md §18-1。C-510）。今までに残した careLevel の行は、今の読み方のまま読む。
// 障害支援区分には有効期間を持たせない（EM に採用値がない。design.md §11-4・L-48）
import { monthRange } from "../demo/period";
import { addDays } from "../engine/rules/util";
import { BUILDING_BANDS, type BuildingBand, type Fact, type Facts, type Residence } from "../engine/types";

export const PATIENT_FACT_KEYS = ["careLevel", "careCert", "terminalCancer", "disabilitySupportLevel", "table7", "table8_2", "table8_3Other", "homeOxygen", "residence", "contactDocProvided", "emergencyEligible", "comprehensiveCare", "buildingBand"] as const;
export type PatientFactKey = (typeof PATIENT_FACT_KEYS)[number];
export const FACT_SOURCES = ["介護保険証", "受給者証", "カルテ", "カルテ以外の記録", "医師に確認"] as const;
export const RESIDENCES: Residence[] = ["居宅", "施設入居等"];
export type FactSource = (typeof FACT_SOURCES)[number];

/**
 * 単一建物診療患者の人数の区分（design.md §15-4。段 17f）：月ごとに入れ直すのではなく、変わったときに「いつの診療月から」つきで残す。
 * 効く値は、fromMonth がその診療年月以前の行のうち fromMonth が最大の行（同じ fromMonth なら後に残した行。施設の申告と同じ選び方）。月の途中の変化の欄は持たない（V-4）
 */
export type BuildingBandValue = { band: BuildingBand; fromMonth: string };
/**
 * 要介護・要支援の認定（design.md §18-1。C-510・C-493）：要介護（1〜5）／要支援（1・2）／認定なし（確かめた）／分からない。
 * 要介護・要支援は有効期間の始まり（validFrom。値の中に持つ）と終わり（validUntil）が要る。認定なし・分からないは日付を持たない。
 * 認定なし・分からないの forMonth は答えた診療月（答えた請求の診療年月。入力では受け取らず、残すときにサーバーが付ける。design.md §18-12 の 1）
 */
export type CareCertValue = { kind: "要介護"; level: number; validFrom: string } | { kind: "要支援"; level: number; validFrom: string } | { kind: "認定なし"; forMonth?: string } | { kind: "分からない"; forMonth?: string };
export const CARE_CERT_KINDS = ["要介護", "要支援", "認定なし", "分からない"] as const;
/** 「認定なし」を確かめ直すまでの月数（設計で置いた値。制度の数字ではない。design.md §18-1） */
export const CARE_NONE_RECHECK_MONTHS = 6;
export type PatientFactInput = { key: PatientFactKey; value: number | boolean | Residence | BuildingBandValue | CareCertValue; source: FactSource; validUntil: string | null };
/** patientId は患者マスタの id（保険が変わっても同じ人に付いたままになる。FR-67・FR-121） */
export type PatientFact = PatientFactInput & { patientId: string; checkedAt: string; checkedBy: string };

const dateOf = (iso: string) => iso.slice(0, 10);

/** 期限が切れているか。now は時刻付き（+09:00）、validUntil は YYYY-MM-DD */
export const isExpired = (f: Pick<PatientFact, "validUntil">, now: string): boolean => f.validUntil !== null && dateOf(now) > f.validUntil;

/**
 * その値が診療年月の全部の日に効くか（design.md §18-1。判断 A）。validUntil が null か診療年月の末日以上で、validFrom（あれば）が診療年月の初日以下なら効く。
 * 月の途中で切れる・始まる（その月のうち効かない日がある）と、月より前に切れた・月より後に始まるは、どれも効かない（「分からない」にする）
 */
export function effectiveFor(f: { validUntil: string | null; validFrom?: string | null }, yearMonth: string): boolean {
  const { start, end } = monthRange(yearMonth);
  if (f.validUntil !== null && f.validUntil < end) return false;
  if (f.validFrom != null && f.validFrom > start) return false;
  return true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" に月数を足す（月末をはみ出す日はその月の末日にする） */
export function addMonthsTo(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ym = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
  const last = Number(monthRange(ym).end.slice(8));
  return `${ym}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** 入力の検査。要介護度は 0〜5 の整数で、有効期間の終わりが要る。障害支援区分は 0〜6 の整数（0 は認定なし）、居住の場所は居宅か施設入居等、ほかは真偽値で、どれも期限は持たない */
export function validatePatientFact(f: PatientFactInput, now: string): void {
  if (!PATIENT_FACT_KEYS.includes(f.key)) throw new Error(`残せない項目: ${f.key}`);
  if (!FACT_SOURCES.includes(f.source)) throw new Error(`確かめた根拠が選べない値: ${f.source}`);
  if (f.key === "careLevel") {
    if (typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 0 || f.value > 5) throw new Error("要介護度は 0〜5 で選ぶ");
    if (!f.validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(f.validUntil)) throw new Error("要介護度には有効期間の終わりの日が要る");
    // 有効期間の終わりが今日より前でも入れられる（過ぎた月の点検のために、切れた認定も入れる。design.md §18-1）
  } else if (f.key === "careCert") {
    const v = f.value as Partial<{ kind: string; level: number; validFrom: string }> | null;
    if (typeof v !== "object" || v === null || !(CARE_CERT_KINDS as readonly string[]).includes(v.kind ?? "")) throw new Error("認定は、要介護・要支援・認定なし・分からないから選ぶ");
    if (v.kind === "要介護" || v.kind === "要支援") {
      const max = v.kind === "要介護" ? 5 : 2;
      if (typeof v.level !== "number" || !Number.isInteger(v.level) || v.level < 1 || v.level > max) throw new Error(v.kind === "要介護" ? "要介護は 1〜5 で選ぶ" : "要支援は 1・2 で選ぶ");
      if (typeof v.validFrom !== "string" || !DATE_RE.test(v.validFrom)) throw new Error("認定には有効期間の始まりの日が要る");
      if (!f.validUntil || !DATE_RE.test(f.validUntil)) throw new Error("認定には有効期間の終わりの日が要る");
      if (v.validFrom > f.validUntil) throw new Error("有効期間の始まりが、終わりより後になっている");
      if (Object.keys(v).some((k) => !["kind", "level", "validFrom"].includes(k))) throw new Error("認定の値に余分な項目がある");
    } else {
      if (Object.keys(v).some((k) => k !== "kind")) throw new Error("認定なし・分からないには、区分と日付を付けない");
      if (f.validUntil !== null) throw new Error("認定なし・分からないに期限は付けない");
    }
  } else if (f.key === "disabilitySupportLevel") {
    if (typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 0 || f.value > 6) throw new Error("障害支援区分は 0〜6 で選ぶ");
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  } else if (f.key === "buildingBand") {
    const v = f.value as Partial<BuildingBandValue> | null;
    if (typeof v !== "object" || v === null || !BUILDING_BANDS.includes(v.band as BuildingBand)) throw new Error("人数の区分は、1 人・2〜9 人・10〜19 人・20〜49 人・50 人以上から選ぶ");
    if (typeof v.fromMonth !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v.fromMonth)) throw new Error("人数の区分には、いつの診療月からの値かが要る");
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  } else if (f.key === "residence") {
    if (!(RESIDENCES as unknown[]).includes(f.value)) throw new Error("居住の場所は、居宅か施設入居等から選ぶ");
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  } else {
    if (typeof f.value !== "boolean") throw new Error(`${f.key} は当たる・当たらないで選ぶ`);
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  }
}

/**
 * カルテ側の事実に、残した最新の値を重ねる。期限は診療年月で比べ、診療年月の全部の日に効かない値は「分からない」にする（design.md §18-1）。
 * 要介護度（careLevel）は、認定の行の全部から careStateOf で決めるので、ここでは重ねない（呼び出し側が careLevelOf で重ねる）
 */
export function applyPatientFacts(facts: Facts, latest: PatientFact[], yearMonth: string): Facts {
  const out: Facts = { ...facts };
  for (const f of latest) {
    // 人数の区分は「いつの診療月から」で選ぶので、ここでは重ねない（buildingBandOfRows。呼び出し側が診療年月で重ねる）
    if (f.key === "buildingBand" || f.key === "careLevel" || f.key === "careCert") continue;
    if (!effectiveFor(f, yearMonth)) out[f.key] = { known: false };
    else if (f.key === "disabilitySupportLevel") out[f.key] = { known: true, value: f.value as number };
    else if (f.key === "residence") out.residence = { known: true, value: f.value as Residence };
    else out[f.key] = { known: true, value: f.value as boolean };
  }
  return out;
}

/** 患者の人数の区分の行（古い順）から、その診療年月で効く値（施設の申告の効く行と同じ選び方。design.md §15-4）。効く行がなければ分からない */
export function buildingBandOfRows(rows: Pick<PatientFact, "key" | "value">[], yearMonth: string): Fact<BuildingBand> {
  let best: BuildingBandValue | null = null;
  for (const r of rows) {
    if (r.key !== "buildingBand") continue;
    const v = r.value as BuildingBandValue;
    if (v.fromMonth <= yearMonth && (best === null || v.fromMonth >= best.fromMonth)) best = v;
  }
  return best ? { known: true, value: best.band } : { known: false };
}

/**
 * 診療年月の要介護・要支援の認定（design.md §18-1）。segments は月の中の区間（1 つか、月の途中で区分が変わった続いた 2 つ）。
 * kind の「区分不明」は、今までに careLevel 0 で残した行（認定なしか要支援かを区別していなかった。C-504）。level は判定に渡す careLevel（要介護 n→n、ほかは 0）
 */
export type CareSegment = { kind: "要介護" | "要支援" | "認定なし" | "区分不明"; level: number };
export type CareState = { known: false } | { known: true; segments: CareSegment[]; source: FactSource; checkedAt: string };

/** 認定の行（careCert と今までの careLevel。古い順）から、診療年月の認定を決める。careCert の行が 1 つでもあれば、そちらだけを読む */
export function careStateOf(rows: PatientFact[], yearMonth: string): CareState {
  const certs = rows.filter((r) => r.key === "careCert");
  if (certs.length === 0) {
    const legacy = rows.filter((r) => r.key === "careLevel").at(-1);
    if (!legacy || !effectiveFor(legacy, yearMonth)) return { known: false };
    const level = legacy.value as number;
    return { known: true, segments: [{ kind: level === 0 ? "区分不明" : "要介護", level }], source: legacy.source, checkedAt: legacy.checkedAt };
  }
  // 先に診療月に当たる行を選ぶ（design.md §18-12 の 1。X-370）：期間つきの認定（要介護・要支援）がその月に当たれば、それを採り、
  // 「認定なし」の 6 か月・「分からない」より優先する（過去の月の答えが、後の月の値を上書きしない）。同じ始まりの日は後に残した行を使う
  const byFrom = new Map<string, PatientFact>();
  for (const r of certs) {
    const k = (r.value as CareCertValue).kind;
    if (k === "要介護" || k === "要支援") byFrom.set((r.value as { validFrom: string }).validFrom, r);
  }
  const { start, end } = monthRange(yearMonth);
  const dated = [...byFrom.values()]
    .filter((r) => (r.value as { validFrom: string }).validFrom <= end && (r.validUntil ?? "9999-12-31") >= start)
    .sort((a, b) => (a.value as { validFrom: string }).validFrom.localeCompare((b.value as { validFrom: string }).validFrom));
  // 同じ月の訂正（X-380）：その診療月について答えた「認定なし」「分からない」が、その月に当たる期間つきの認定より後に残したものなら、その月ではそれを優先する。
  // ほかの月について答えた行は、期間つきの認定を上書きしない（X-370）
  const lastDated = Math.max(-1, ...dated.map((r) => certs.indexOf(r)));
  const sameMonth = certs.map((r, i) => ({ r, i })).filter(({ r, i }) => i > lastDated && (r.value as { forMonth?: string }).forMonth === yearMonth).at(-1);
  if (dated.length > 0 && sameMonth) {
    const k = (sameMonth.r.value as CareCertValue).kind;
    return k === "認定なし" ? { known: true, segments: [{ kind: "認定なし", level: 0 }], source: sameMonth.r.source, checkedAt: sameMonth.r.checkedAt } : { known: false };
  }
  if (dated.length === 0) {
    // 期間つきの認定が当たらない月：その月に効く「認定なし」（確かめた診療月から 6 か月。前の月には効かない。X-354）と「分からない」のうち、後に残した行
    const none = (r: PatientFact) => {
      const v = r.value as CareCertValue;
      if (v.kind !== "認定なし") return false;
      // 確かめた診療月を持たない行は、確かめた日の月を確かめた診療月として読む
      const from = v.forMonth ?? r.checkedAt.slice(0, 7);
      return from <= yearMonth && yearMonth <= addMonthsTo(`${from}-01`, CARE_NONE_RECHECK_MONTHS - 1).slice(0, 7);
    };
    const hit = certs.filter((r) => none(r) || (r.value as CareCertValue).kind === "分からない").at(-1);
    return hit && (hit.value as CareCertValue).kind === "認定なし" ? { known: true, segments: [{ kind: "認定なし", level: 0 }], source: hit.source, checkedAt: hit.checkedAt } : { known: false };
  }
  const latest = dated[dated.length - 1];
  const seg = (r: PatientFact): CareSegment => {
    const c = r.value as Extract<CareCertValue, { validFrom: string }>;
    return { kind: c.kind, level: c.kind === "要介護" ? c.level : 0 };
  };
  const meta = { source: latest.source, checkedAt: latest.checkedAt };
  if (dated.length === 1 && effectiveFor({ validUntil: dated[0].validUntil, validFrom: (dated[0].value as { validFrom: string }).validFrom }, yearMonth)) return { known: true, segments: [seg(dated[0])], ...meta };
  // 月の途中で区分が変わった：続いた 2 行（古い行の終わりの翌日が新しい行の始まり）で月の全部の日を覆うとき
  if (dated.length === 2) {
    const [a, b] = dated;
    const aFrom = (a.value as { validFrom: string }).validFrom;
    const bFrom = (b.value as { validFrom: string }).validFrom;
    if (aFrom <= start && a.validUntil !== null && addDays(a.validUntil, 1) === bFrom && (b.validUntil === null || b.validUntil >= end)) return { known: true, segments: [seg(a), seg(b)], ...meta };
  }
  return { known: false };
}

/**
 * 判定に渡す要介護度（R03・R17・D04 が読む）。月の途中で区分が変わったときは、要介護 careLevelMin 以上かどうかが 2 つの区間で同じなら効き、
 * 値は月の終わりの区間のもの（design.md §18-1）。違えば「分からない」
 */
export function careLevelOf(state: CareState, careLevelMin: number): Fact<number> {
  if (!state.known) return { known: false };
  const sides = new Set(state.segments.map((s) => s.level >= careLevelMin));
  return sides.size === 1 ? { known: true, value: state.segments[state.segments.length - 1].level } : { known: false };
}

/**
 * 要介護・要支援の認定があるか（R20 の ④ と、短期入所を聞くか。design.md §18-1・§18-3・§18-5）。区間で答えが違う・今までの careLevel 0（区分不明）は「分からない」
 */
export function certifiedOf(state: CareState): Fact<boolean> {
  if (!state.known || state.segments.some((s) => s.kind === "区分不明")) return { known: false };
  const v = new Set(state.segments.map((s) => s.kind === "要介護" || s.kind === "要支援"));
  return v.size === 1 ? { known: true, value: [...v][0] } : { known: false };
}
