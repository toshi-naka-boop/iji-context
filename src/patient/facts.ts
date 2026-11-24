// 患者ごとに確かめた情報（要介護度・障害支援区分・別表第七・別表第八の二・別表第八の三のほかの状態・在宅酸素・居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者か）。
// 月をまたいで残る（design.md §6-1 の「単位：患者」の行）。その月・その日の出来事についての事実は、請求ごと（src/claim/facts.ts）に持つ。
// 判定はカルテ側の事実に、残した最新の値を重ねて使う。期限は今日ではなく診療年月で比べる（design.md §18-1。判断 A）：診療年月の全部の日に効く値だけを使い、月の途中で切れる・始まる値は「分からない」にする。
// 要介護・要支援の認定は careCert で持つ（design.md §18-1。C-510）。今までに残した careLevel の行は、今の読み方のまま読む。
// 障害支援区分には有効期間を持たせない（EM に採用値がない。design.md §11-4・L-48）
import { monthRange } from "../demo/period";
import { addDays, isRealDate } from "../engine/rules/util";
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
export type CareCertValue = { kind: "要介護"; level: number; validFrom: string; forMonth?: string } | { kind: "要支援"; level: number; validFrom: string; forMonth?: string } | { kind: "認定なし"; forMonth?: string } | { kind: "申請中"; forMonth?: string } | { kind: "分からない"; forMonth?: string };
/** 申請中（EM §7-2 U-71。2026-11-24 利用者の判断）：R03 には「分からない」、④・短期入所には「認定なし」に準じて読む。答えた診療月だけに効く（6 か月は残さず、翌月の点検でまた聞く） */
export const CARE_CERT_KINDS = ["要介護", "要支援", "認定なし", "申請中", "分からない"] as const;
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

const DATE_RE = { test: (s: string) => isRealDate(s) };

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
    if (typeof v !== "object" || v === null || !(CARE_CERT_KINDS as readonly string[]).includes(v.kind ?? "")) throw new Error("認定は、要介護・要支援・認定なし・申請中・分からないから選ぶ");
    if (v.kind === "要介護" || v.kind === "要支援") {
      const max = v.kind === "要介護" ? 5 : 2;
      if (typeof v.level !== "number" || !Number.isInteger(v.level) || v.level < 1 || v.level > max) throw new Error(v.kind === "要介護" ? "要介護は 1〜5 で選ぶ" : "要支援は 1・2 で選ぶ");
      if (typeof v.validFrom !== "string" || !DATE_RE.test(v.validFrom)) throw new Error("認定には有効期間の始まりの日が要る");
      if (!f.validUntil || !DATE_RE.test(f.validUntil)) throw new Error("認定には有効期間の終わりの日が要る");
      if (v.validFrom > f.validUntil) throw new Error("有効期間の始まりが、終わりより後になっている");
      if (Object.keys(v).some((k) => !["kind", "level", "validFrom"].includes(k))) throw new Error("認定の値に余分な項目がある");
    } else {
      if (Object.keys(v).some((k) => k !== "kind")) throw new Error("認定なし・申請中・分からないには、区分と日付を付けない");
      if (f.validUntil !== null) throw new Error("認定なし・申請中・分からないに期限は付けない");
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
export type CareSegment = { kind: "要介護" | "要支援" | "認定なし" | "申請中" | "区分不明"; level: number };
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
  return careCertFor(certs, yearMonth);
}

/**
 * careCert の行（古い順）から診療年月 M の認定を決める、全会一致の規則（1 か所。design.md §18-12 の 1「全会一致の規則（v40）」）。3 段だけで決める：
 *  1. 語る行：M に当たる期間つきの認定／答えた月から 6 か月の窓が M に当たる「認定なし」「申請中」／M について答えた「分からない」／答えた月が M 以前の不正な日付の行（その後ずっと語る）
 *  2. 捨てる：行 X は、M について語る別の行 Y が、答えた月が X と同じか後で、かつ X より後に残したとき、M では捨てる（答えた月と残した順の両方で負けた行だけ）。
 *     ただし「申請の結果ですか」に「いいえ」「分からない」と答えた期間つきの認定は、申請中を捨てない
 *  3. 決める：残った行の値がすべて同じ確定の値（要介護 n・要支援 n・認定なし）のときだけ、その値。違う値か、申請中・分からない・不正な行が残れば分からない（聞き取りの対象）
 * 答えた月は forMonth（持たない今までの行は確かめた日の月）。期間つきの認定が M の全部の日を覆わない（月の途中で切れる・始まる）ときは分からない。月の途中で区分が変わった続いた 2 行は、2 つの区間として返す（§18-1）
 */
export function careCertFor(certs: PatientFact[], yearMonth: string): CareState {
  const { start, end } = monthRange(yearMonth);
  const monthOf = (r: PatientFact) => (r.value as { forMonth?: string }).forMonth ?? r.checkedAt.slice(0, 7);
  const kindOf = (r: PatientFact) => (r.value as CareCertValue).kind;
  const isDated = (r: PatientFact) => kindOf(r) === "要介護" || kindOf(r) === "要支援";
  const from = (r: PatientFact) => (r.value as { validFrom: string }).validFrom;
  const valid = (r: PatientFact) => isRealDate(from(r)) && (r.validUntil === null || isRealDate(r.validUntil));
  const inWindow = (r: PatientFact) => monthOf(r) <= yearMonth && yearMonth <= addMonthsTo(`${monthOf(r)}-01`, CARE_NONE_RECHECK_MONTHS - 1).slice(0, 7);
  // 1. 語る行
  const talks = (r: PatientFact): boolean => {
    const k = kindOf(r);
    if (isDated(r)) return valid(r) ? from(r) <= end && (r.validUntil ?? "9999-12-31") >= start : monthOf(r) <= yearMonth;
    if (k === "認定なし" || k === "申請中") return inWindow(r);
    return monthOf(r) === yearMonth;
  };
  const talking = certs.map((r, i) => ({ r, i })).filter(({ r }) => talks(r));
  // 2. 捨てる
  const notFromApplication = (r: PatientFact) => isDated(r) && ["いいえ", "分からない"].includes((r.value as { fromApplication?: string }).fromApplication ?? "");
  // 期間つきの認定どうしは、期間の重なる（同じ日について語る）ときだけ負かす（月の途中で区分が変わった続いた 2 行は両方残る。§18-1）
  const overlap = (a: PatientFact, b: PatientFact) => !valid(a) || !valid(b) || (from(a) <= (b.validUntil ?? "9999-12-31") && from(b) <= (a.validUntil ?? "9999-12-31"));
  const beats = (y: { r: PatientFact; i: number }, x: { r: PatientFact; i: number }) =>
    y.i > x.i && monthOf(y.r) >= monthOf(x.r) && !(kindOf(x.r) === "申請中" && notFromApplication(y.r)) && !(isDated(x.r) && isDated(y.r) && !overlap(x.r, y.r));
  const rest = talking.filter((x) => !talking.some((y) => beats(y, x))).map((x) => x.r);
  // 3. 決める。残ったのが申請中だけなら申請中（R03 には分からない、④・短期入所には認定なしに準じる。U-71）
  if (rest.length > 0 && rest.every((r) => kindOf(r) === "申請中")) {
    const r = rest[rest.length - 1];
    return { known: true, segments: [{ kind: "申請中", level: 0 }], source: r.source, checkedAt: r.checkedAt };
  }
  if (rest.length === 0 || rest.some((r) => (isDated(r) && !valid(r)) || kindOf(r) === "申請中" || kindOf(r) === "分からない")) return { known: false };
  const nones = rest.filter((r) => kindOf(r) === "認定なし");
  const dated = rest.filter(isDated);
  if (nones.length > 0 && dated.length > 0) return { known: false };
  if (nones.length > 0) {
    const r = nones[nones.length - 1];
    return { known: true, segments: [{ kind: "認定なし", level: 0 }], source: r.source, checkedAt: r.checkedAt };
  }
  const levelOf = (r: PatientFact) => `${kindOf(r)}:${(r.value as { level: number }).level}`;
  const sorted = [...dated].sort((a, b) => from(a).localeCompare(from(b)));
  // 全部が同じ値で、どれかが月の全部の日を覆う → その値
  if (new Set(dated.map(levelOf)).size === 1) {
    const full = sorted.filter((r) => effectiveFor({ validUntil: r.validUntil, validFrom: from(r) }, yearMonth)).at(-1);
    if (full) return segmentsOf([full], yearMonth);
  }
  // 月の途中で区分が変わった続いた 2 行（§18-1）
  return sorted.length === 2 ? segmentsOf(sorted, yearMonth) : { known: false };
}


/** M に当たる期間つきの行（実在する日付だけ）から区間を作る：1 行で月の全部の日を覆うか、続いた 2 行 */
function segmentsOf(dated: PatientFact[], yearMonth: string): CareState {
  const { start, end } = monthRange(yearMonth);
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
  // 申請中は R03 に「分からない」（認定が申請日に遡って効くので、0 として渡さない。U-71）
  if (!state.known || state.segments.some((s) => s.kind === "申請中")) return { known: false };
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
