// 患者マスタのプロフィール（患者と、その保険・公費の加入情報）の型と、そこからエンジンの Facts を出す関数（spec FR-121、design.md §6）
// ここは純関数だけ。DB の読み書きは src/server/app/patients.ts
import type { Facts } from "../engine/types";
import { monthRange } from "../demo/period";
import type { UkePatient } from "../uke/types";

export const COVERAGE_KINDS = ["医保", "公費"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

/** 確かめた根拠（何を見て確かめたか） */
export const COVERAGE_SOURCES = ["オンライン資格確認", "保険証・資格確認書", "受給者証"] as const;
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];

/** 負担割合として入力できる値（EM §2-5 P-9・P-10 に出てくる割合） */
export const BURDEN_RATIOS = [0.1, 0.2, 0.3] as const;

/** 加入情報の中身。出所（UKE・連携のコネクタ・確認入力）を問わず、この形で持つ */
export type CoverageInfo = {
  kind: CoverageKind;
  /** 保険者番号（医保）または公費負担者番号（公費） */
  payerNumber: string;
  /** 記号（医保だけ。公費は空） */
  symbol: string;
  /** 番号（医保）または受給者番号（公費） */
  memberNo: string;
  /** 負担割合（0.1 など）。分からないとき・公費は null */
  burdenRatio: number | null;
  /** 有効期間 YYYY-MM-DD。分からない・定めがないときは null */
  validFrom: string | null;
  validUntil: string | null;
};

/** 加入情報 1 件（履歴のうち最新の 1 行） */
export type Coverage = CoverageInfo & {
  /** 加入情報の id（番号を直しても変わらない） */
  coverageId: string;
  /** 並び順。医保は 0、公費は 1 から（第 1 公費＝1） */
  position: number;
  /** 出所（"UKE"・"連携"・"移行"、または確かめた根拠） */
  source: string;
  /** 医療事務が確かめた記録。取り込んだだけの行は null */
  checkedBy: string | null;
  checkedAt: string | null;
};

/** 患者マスタに取り込む患者 1 人分。UKE から来ても、連携のコネクタから来ても同じ形（spec FR-123） */
export type PatientRecord = {
  name: string;
  /** 1 男、2 女。出所が「不明・その他」を返したときは null */
  sex: 1 | 2 | null;
  /** YYYYMMDD */
  birth: string;
  /** 医保を先に、公費は順位の順に並べる */
  coverages: CoverageInfo[];
};

/** UKE の患者を、患者マスタに取り込む形にする（UKE は負担割合と有効期間を持たない） */
export function recordOfUke(p: UkePatient): PatientRecord {
  const blank = { burdenRatio: null, validFrom: null, validUntil: null };
  return {
    name: p.name,
    sex: p.sex,
    birth: p.birth,
    coverages: [
      { ...blank, kind: "医保", payerNumber: p.insurer.number, symbol: p.insurer.symbol, memberNo: p.insurer.no },
      ...p.kohi.map((k) => ({ ...blank, kind: "公費" as const, payerNumber: k.payerNo, symbol: "", memberNo: k.recipientNo })),
    ],
  };
}

/** 全角の英数字・記号と全角の空白を半角にする（記号・番号は、患者マスタに入れる時点で半角にそろえる） */
export const toHalfWidth = (s: string): string => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");

export type PatientProfile = {
  patientId: string;
  name: string | null;
  /** 性別コード（UKE の値のまま） */
  sex: number | null;
  /** YYYYMMDD（UKE の値のまま） */
  birth: string | null;
  coverages: Coverage[];
  /** 要介護認定の記録（医療事務が確かめたもの。FR-67）。残っていなければ null */
  careCertification: { validUntil: string | null } | null;
  /** その月のレセプトのレセプト種別（請求があるときだけ） */
  receiptType?: string | null;
  /** 症例側（合成カルテ・受給者証情報）が持つ負担割合。患者マスタに負担割合が入っていないときだけ使う */
  caseBurdenRatio?: number | null;
};

/** 生年月日（YYYYMMDD）を YYYY-MM-DD にする。8 桁の数字でない・暦にない日は null */
export function birthDate(birth: string | null): string | null {
  if (!birth || !/^\d{8}$/.test(birth)) return null;
  const y = Number(birth.slice(0, 4));
  const m = Number(birth.slice(4, 6));
  const d = Number(birth.slice(6, 8));
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}`;
}

/** その日の満年齢（誕生日の当日に 1 つ上がる数え方）。born・on は YYYY-MM-DD */
export function ageOn(born: string, on: string): number {
  const age = Number(on.slice(0, 4)) - Number(born.slice(0, 4));
  return on.slice(5) < born.slice(5) ? age - 1 : age;
}

/** 有効期間がその期間（from〜to）に少しでも重なるか。期限が分からない側は開いているものとして扱う */
export const overlaps = (c: Pick<Coverage, "validFrom" | "validUntil">, from: string, to: string): boolean =>
  (c.validUntil === null || c.validUntil >= from) && (c.validFrom === null || c.validFrom <= to);

/** その月に有効な加入情報（期間が月に重なるもの）。並びは 医保→公費の順位 */
export function coveragesIn(profile: Pick<PatientProfile, "coverages">, yearMonth: string): Coverage[] {
  const { start, end } = monthRange(yearMonth);
  return profile.coverages.filter((c) => overlaps(c, start, end)).sort((a, b) => a.position - b.position);
}

/** 後期高齢者医療の保険者番号か（法別番号 39。EM §2-5 P-7） */
export const isLateElderly = (payerNumber: string): boolean => /^39\d{6}$/.test(payerNumber);

/** 法別番号（医療保険）→ 保険種別の呼び名（EM §2-5 P-7）。6 桁は国民健康保険（P-1） */
const INSURANCE_BY_HOBETSU: Record<string, string> = {
  "01": "協会けんぽ",
  "02": "船員保険",
  "03": "日雇特例",
  "04": "日雇特例",
  "06": "組合健保",
  "07": "自衛官",
  "39": "後期高齢者",
  "31": "共済組合",
  "32": "共済組合",
  "33": "共済組合",
  "34": "共済組合",
  "63": "特例退職",
  "72": "特例退職",
  "73": "特例退職",
  "74": "特例退職",
  "75": "特例退職",
};

/** 保険者番号から保険種別の呼び名を出す。表にない番号は null */
export function insuranceOf(payerNumber: string): string | null {
  if (/^\d{6}$/.test(payerNumber)) return "国保";
  if (/^\d{8}$/.test(payerNumber)) return INSURANCE_BY_HOBETSU[payerNumber.slice(0, 2)] ?? null;
  return null;
}

/**
 * 患者マスタから、エンジンの Facts の年齢・保険種別・負担割合を出す（design.md §6）。
 * 年齢は診療年月の初日の満年齢。保険種別と負担割合は、その月に有効な医保の加入情報から。
 * 有効な医保が 0 件または 2 件以上のとき、値が入っていないときは「分からない」
 */
export function factsFromPatient(profile: PatientProfile, yearMonth: string): Pick<Facts, "age" | "insurance" | "burdenRatio"> {
  const born = birthDate(profile.birth);
  const age: Facts["age"] = born ? { known: true, value: ageOn(born, monthRange(yearMonth).start) } : { known: false };
  const medical = coveragesIn(profile, yearMonth).filter((c) => c.kind === "医保");
  if (medical.length !== 1) return { age, insurance: { known: false }, burdenRatio: { known: false } };
  const label = insuranceOf(medical[0].payerNumber);
  const ratio = medical[0].burdenRatio;
  return {
    age,
    insurance: label ? { known: true, value: label } : { known: false },
    burdenRatio: ratio === null ? { known: false } : { known: true, value: ratio },
  };
}
