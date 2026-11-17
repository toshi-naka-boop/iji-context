// 患者情報チェック P01〜P08（spec FR-116〜123）。ユスティ（src/engine/）とは別の系統で、宛先は常に医療事務。
// 判定は決定的な純関数で、LLM を使わない。制度の数字・算法は EM §2-5 の採用値だけを使う（対応は CHECK_BASIS）。
// 扱わないもの：月の途中で 75 歳になる月の特例、限度額適用認定証、地方単独の公費の個別の決まり、70 歳未満の負担割合
import { ageOn, birthDate, coveragesIn, isLateElderly, monthRange, overlaps, type Coverage, type PatientProfile } from "./profile";

export const PATIENT_CHECK_IDS = ["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08"] as const;
export type PatientCheckId = (typeof PATIENT_CHECK_IDS)[number];

export const PATIENT_FINDING_KINDS = ["期限", "不整合", "形式", "情報不足"] as const;
export type PatientFindingKind = (typeof PATIENT_FINDING_KINDS)[number];

export type PatientFinding = {
  checkId: PatientCheckId;
  kind: PatientFindingKind;
  /** 対象の項目（payerNumber・memberNo・burdenRatio・validUntil・birth・sex・name・receiptType・kohiOrder・careLevel・coverage） */
  field: string;
  /** 加入情報についての指摘なら、その id */
  coverageId?: string;
  /** 文言のキー（src/messages.ts の PATIENT_FINDING_TEXT） */
  messageKey: string;
  /** 文言に差し込む値（法別番号など。氏名・番号・生年月日は入れない） */
  params?: Record<string, string>;
  /** 根拠（EM の行、または仕様の FR） */
  reference: string;
  /** 判定の基準日。診療年月で見たものは YYYY-MM、今日の日付で見たものは YYYY-MM-DD */
  basisDate: string;
};

/**
 * チェックごとの根拠。em は EM（evidence-master）の行の番号、spec は仕様の FR。
 * P06〜P08 は日付の比較と記録の形だけを見ていて、制度の数字を使わない（EM に行がない）
 */
export const CHECK_BASIS: Record<PatientCheckId, { em: string[]; spec: string }> = {
  P01: { em: ["P-1", "P-2", "P-3", "P-4"], spec: "FR-119" },
  P02: { em: ["P-7", "P-8"], spec: "FR-119" },
  P03: { em: ["P-9", "P-10", "L-3"], spec: "FR-119" },
  P04: { em: ["L-3", "P-7", "P-10"], spec: "FR-119" },
  P05: { em: ["L-5", "10-1"], spec: "FR-119" },
  P06: { em: [], spec: "FR-122" },
  P07: { em: [], spec: "FR-67" },
  P08: { em: [], spec: "FR-119" },
};

const referenceOf = (id: PatientCheckId): string => {
  const b = CHECK_BASIS[id];
  return b.em.length > 0 ? `EM §2-5 ${b.em.join("・")}` : `spec ${b.spec}`;
};

/** 判定の基準：診療年月と、今日の日付（デモの時計）。診療日が分かっていれば渡す（期間の外の診療日を見分ける） */
export type CheckBasis = { yearMonth: string; today: string; serviceDates?: string[] };

/** 要介護認定の期限が「近い」とみなす日数（設計の値。制度の数字ではない） */
export const CARE_EXPIRY_NOTICE_DAYS = 30;

// ---------------------------------------------------------------------------
// P01 番号の桁数と検証番号（EM §2-5 P-1〜P-4）

/**
 * 検証番号を求める（EM §2-5 P-2）。body は検証番号を除いた数字の並び。
 * 末尾の桁から順に 2・1 を掛け、積の和を取る（積が 2 桁なら十の位と一の位を足す）。10 からその下 1 桁を引く。下 1 桁が 0 なら 0
 */
export function checkDigitOf(body: string): number {
  let sum = 0;
  [...body].reverse().forEach((ch, i) => {
    const p = Number(ch) * (i % 2 === 0 ? 2 : 1);
    sum += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
  });
  return (10 - (sum % 10)) % 10;
}

/** 末尾の 1 桁が検証番号として合っているか（数字だけの並びであること） */
export const checkDigitOk = (number: string): boolean => /^\d{2,}$/.test(number) && checkDigitOf(number.slice(0, -1)) === Number(number.slice(-1));

function p01(c: Coverage, at: string): PatientFinding[] {
  const out: PatientFinding[] = [];
  const add = (field: string, messageKey: string) =>
    out.push({ checkId: "P01", kind: "形式", field, coverageId: c.coverageId, messageKey, reference: referenceOf("P01"), basisDate: at });
  if (c.kind === "医保") {
    // 保険者番号は 8 桁。国民健康保険は法別番号のない 6 桁
    if (!/^(\d{8}|\d{6})$/.test(c.payerNumber)) add("payerNumber", "P01.insurer_length");
    else if (!checkDigitOk(c.payerNumber)) add("payerNumber", "P01.insurer_check_digit");
  } else {
    if (!/^\d{8}$/.test(c.payerNumber)) add("payerNumber", "P01.kohi_payer_length");
    else if (!checkDigitOk(c.payerNumber)) add("payerNumber", "P01.kohi_payer_check_digit");
    if (!/^\d{7}$/.test(c.memberNo)) add("memberNo", "P01.recipient_length");
    else if (!checkDigitOk(c.memberNo)) add("memberNo", "P01.recipient_check_digit");
  }
  return out;
}

// ---------------------------------------------------------------------------
// P03・P04 レセプト種別コード（EM §2-5 L-3 にある 6 つだけ。ほかのコードは判定しない）

type ReceiptTypeRule = {
  /** 後期高齢者医療か */
  lateElderly: boolean;
  /** 併用する公費の数 */
  kohi: number;
  /** 高齢受給者（70〜74 歳）のコードか。後期高齢者のコードは年齢を P02 で見るので null */
  senior: boolean | null;
  /** そのコードで取り得る負担割合（10 倍の整数）。EM に値がないコードは null */
  ratios: number[] | null;
};

const RECEIPT_TYPES: Record<string, ReceiptTypeRule> = {
  "1112": { lateElderly: false, kohi: 0, senior: false, ratios: null },
  "1118": { lateElderly: false, kohi: 0, senior: true, ratios: [2] },
  "1110": { lateElderly: false, kohi: 0, senior: true, ratios: [3] },
  "1318": { lateElderly: true, kohi: 0, senior: null, ratios: [1, 2] },
  "1328": { lateElderly: true, kohi: 1, senior: null, ratios: [1, 2] },
  "1310": { lateElderly: true, kohi: 0, senior: null, ratios: [3] },
};

/** 負担割合を 10 倍の整数にする（0.1 → 1）。小数の誤差を避ける */
const tenths = (ratio: number) => Math.round(ratio * 10);

// ---------------------------------------------------------------------------
// P05 公費の順位（EM §2-5 L-5 の掲載順。先のものが第 1 公費）

const KOHI_ORDER = ["13", "14", "18", "29", "30", "10", "11", "20", "21", "15", "16", "24", "22", "28", "17", "79", "19", "23", "52", "54", "51", "38", "53", "66", "62", "25", "12"];

// ---------------------------------------------------------------------------

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const covers = (c: Coverage, date: string) => overlaps(c, date, date);
/** 入れ替わりを見るときの同じ枠：医保どうし、公費は法別番号が同じものどうし */
const sameSlot = (a: Coverage, b: Coverage) => a.kind === b.kind && (a.kind === "医保" || a.payerNumber.slice(0, 2) === b.payerNumber.slice(0, 2));

/**
 * 患者のプロフィールを、診療年月と今日の日付で確かめる。指摘は P01→P08 の順。
 * 加入情報についてのチェック（P01〜P06）は、その月に有効期間が重なる加入情報だけを見る
 */
export function checkPatient(profile: PatientProfile, basis: CheckBasis): PatientFinding[] {
  const { yearMonth, today } = basis;
  const { start, end } = monthRange(yearMonth);
  const active = coveragesIn(profile, yearMonth);
  const medical = active.filter((c) => c.kind === "医保");
  const kohi = active.filter((c) => c.kind === "公費");
  const born = birthDate(profile.birth);
  /** 月の初日・末日の満年齢（生年月日が読めなければ null。P08 が指摘する） */
  const ageStart = born ? ageOn(born, start) : null;
  const ageEnd = born ? ageOn(born, end) : null;
  const out: PatientFinding[] = [];
  const finding = (checkId: PatientCheckId, kind: PatientFindingKind, field: string, messageKey: string, extra: Partial<PatientFinding> = {}) =>
    out.push({ checkId, kind, field, messageKey, reference: referenceOf(checkId), basisDate: yearMonth, ...extra });

  // P01
  for (const c of active) out.push(...p01(c, yearMonth));

  // P02 生年月日と保険の種類（EM P-8：後期高齢者医療は 75 歳以上。65〜74 歳は障害の認定を受けた人）
  // 月の途中で 75 歳になる月は、どちらの保険もあり得るので指摘しない（月の初日・末日の年齢で分ける）
  if (ageStart !== null && ageEnd !== null) {
    for (const c of medical) {
      const late = isLateElderly(c.payerNumber);
      if (late && ageEnd < 65) finding("P02", "不整合", "birth", "P02.late_elderly_under_65", { coverageId: c.coverageId });
      // 65〜74 歳の後期高齢者は例外があり得るので、確かめた記録が付いたら出さない
      else if (late && ageEnd < 75 && !c.checkedAt) finding("P02", "不整合", "birth", "P02.late_elderly_65_74", { coverageId: c.coverageId });
      else if (!late && ageStart >= 75) finding("P02", "不整合", "birth", "P02.over_75_not_late_elderly", { coverageId: c.coverageId });
    }
  }

  // P03 負担割合（EM P-9：後期高齢者は 1・2・3 割／P-10：70〜74 歳は 2 割か 3 割／L-3：レセプト種別との対応）
  const type = profile.receiptType ? RECEIPT_TYPES[profile.receiptType] : undefined;
  for (const c of medical) {
    const at = { coverageId: c.coverageId };
    // 患者マスタに入っていなければ、症例側の値で見る（医保が 1 件に決まるときだけ）。どちらにもなければ情報不足
    const ratio = c.burdenRatio ?? (medical.length === 1 ? profile.caseBurdenRatio ?? null : null);
    if (ratio === null) {
      finding("P03", "情報不足", "burdenRatio", "P03.missing", at);
      continue;
    }
    const r = tenths(ratio);
    const late = isLateElderly(c.payerNumber);
    if (late && ![1, 2, 3].includes(r)) finding("P03", "不整合", "burdenRatio", "P03.late_elderly_ratio", at);
    else if (!late && ageStart !== null && ageStart >= 70 && ageStart <= 74 && ![2, 3].includes(r)) finding("P03", "不整合", "burdenRatio", "P03.age_70_74_ratio", at);
    else if (type?.ratios && medical.length === 1 && !type.ratios.includes(r)) finding("P03", "不整合", "burdenRatio", "P03.receipt_type_ratio", at);
  }

  // P04 レセプト種別コードと、保険の種類・公費の数・年齢
  if (type) {
    if (medical.length === 1 && isLateElderly(medical[0].payerNumber) !== type.lateElderly) finding("P04", "不整合", "receiptType", "P04.insurance_kind");
    if (kohi.length !== type.kohi) finding("P04", "不整合", "receiptType", "P04.kohi_count");
    // 75 歳以上は P02 が指摘するので、ここでは 74 歳までを見る
    if (type.senior !== null && ageStart !== null && ageStart <= 74 && (ageStart >= 70) !== type.senior) finding("P04", "不整合", "receiptType", "P04.age");
  }

  // P05 公費の順位。一覧にない法別番号（地方単独の公費など）は比べない
  const listed = kohi.map((c) => c.payerNumber.slice(0, 2)).filter((h) => KOHI_ORDER.includes(h));
  for (let i = 0; i + 1 < listed.length; i++) {
    if (KOHI_ORDER.indexOf(listed[i]) > KOHI_ORDER.indexOf(listed[i + 1])) {
      finding("P05", "不整合", "kohiOrder", "P05.order", { params: { first: listed[i + 1], second: listed[i] } });
      break;
    }
  }

  // P06 資格・受給者証の有効期間（FR-122）
  if (medical.length === 0) finding("P06", "期限", "coverage", "P06.no_valid_insurance");
  else if (medical.length >= 2) {
    // 月の途中の切替（期間が重ならない並び）なら出さない
    const sorted = [...medical].sort((a, b) => (a.validUntil ?? "9999-12-31").localeCompare(b.validUntil ?? "9999-12-31"));
    const disjoint = sorted.every((c, i) => i === 0 || (sorted[i - 1].validUntil !== null && c.validFrom !== null && sorted[i - 1].validUntil! < c.validFrom));
    if (!disjoint) finding("P06", "情報不足", "coverage", "P06.overlap");
  }
  for (const c of active) {
    const at = { coverageId: c.coverageId };
    const others = active.filter((o) => o !== c && sameSlot(o, c));
    if (c.validUntil === null && !c.checkedAt) {
      // 期限が入っていない（確かめて「期限の定めなし」と残したものは出さない）
      finding("P06", "情報不足", "validUntil", c.kind === "医保" ? "P06.no_period_insurance" : "P06.no_period_kohi", at);
    } else if (basis.serviceDates?.some((d) => !covers(c, d) && !others.some((o) => covers(o, d)))) {
      finding("P06", "期限", "validUntil", "P06.outside_period", at);
    } else if (c.validUntil !== null && today > c.validUntil && !others.some((o) => covers(o, today))) {
      finding("P06", "期限", "validUntil", "P06.expired", { ...at, basisDate: today });
    } else if (!basis.serviceDates && ((c.validUntil !== null && c.validUntil < end) || (c.validFrom !== null && c.validFrom > start))) {
      // 診療日が分からないときは、月の途中の切替を確かめてもらう
      finding("P06", "期限", "validUntil", "P06.mid_month", at);
    }
  }

  // P07 要介護認定の有効期間（FR-67。今日の日付で見る）。
  // 要介護度の記録がない患者には出さない（認定を受けていない人もいる。要介護度が要るときの確認は、ユスティの R03 の情報不足が担う）
  const care = profile.careCertification;
  const p07 = { basisDate: today };
  if (care) {
    if (care.validUntil === null) finding("P07", "情報不足", "careLevel", "P07.missing", p07);
    else if (today > care.validUntil) finding("P07", "期限", "careLevel", "P07.expired", p07);
    else if (care.validUntil <= addDays(today, CARE_EXPIRY_NOTICE_DAYS)) finding("P07", "期限", "careLevel", "P07.expiring_soon", p07);
  }

  // P08 記録の形式
  if (!profile.name || profile.name.trim() === "") finding("P08", "形式", "name", "P08.name_missing");
  if (!born) finding("P08", "形式", "birth", "P08.birth_format");
  else if (born > today) finding("P08", "形式", "birth", "P08.birth_future", { basisDate: today });
  if (profile.sex !== 1 && profile.sex !== 2) finding("P08", "形式", "sex", "P08.sex_code");

  return out;
}
