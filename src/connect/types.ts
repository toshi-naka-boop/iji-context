// 連携の境界の型（spec FR-104）。外部とのやり取りは、患者基本情報／請求／カルテ記載の 3 つに分ける。
// 画面と判定はこの型だけに依存し、個別の接続先（ORCA 形式・FHIR 形式・同梱の合成データ）を知らない
import type { UkeClinic, UkeFile } from "../uke/types";

/**
 * 保険・公費の加入情報 1 件。
 * 患者マスタの型（src/patient/profile.ts。別の作業で作成中）と統合するまでの、同じ趣旨の型
 */
export type ConnectorCoverage = {
  kind: "医療保険" | "公費";
  /** 保険者番号（医療保険）または公費負担者番号（公費） */
  number: string;
  /** 被保険者証の記号（医療保険だけ。ないときは空文字） */
  symbol: string;
  /** 被保険者証の番号（医療保険）または受給者番号（公費） */
  memberNo: string;
  /** 負担割合（0.1 など）。接続先から取れないときは null */
  burdenRatio: number | null;
  /** 有効期間の始まり YYYY-MM-DD。分からないときは null */
  validFrom: string | null;
  /** 有効期間の終わり YYYY-MM-DD。分からない・期限なしは null */
  validUntil: string | null;
};

/** 患者基本情報 */
export type ConnectorPatient = {
  /** 接続先での患者の id（患者番号）。保険者番号に依存しない */
  patientId: string;
  name: string;
  /** 1 男、2 女。接続先が「不明・その他」を返したときは null */
  sex: 1 | 2 | null;
  /** YYYY-MM-DD */
  birth: string;
  coverages: ConnectorCoverage[];
};

/** 対応表にない診療行為コードの行（判定の対象外。spec FR-111） */
export type UnmappedLine = { claimId: string; code: string; dates: string[] };

/** 診療年月の請求。files は UKE を読んだときと同じ形。unmapped が 1 件以上あるレセプトは合計を出さない */
export type ConnectorClaims = { files: UkeFile[]; unmapped: UnmappedLine[] };

/** 診療年月のカルテ記載（患者 1 人分） */
export type ConnectorChart = {
  patientId: string;
  /** YYYY-MM */
  yearMonth: string;
  /** 訪問日ごとの記録。本文を持たない接続先（FHIR の Encounter）では s・a・p は空文字 */
  entries: { date: string; s: string; a: string; p: string }[];
  /** 処方。category は接続先が返した名前（合成カルテでは分類名、FHIR 形式では薬剤の表示名） */
  prescriptions: { date: string; category: string }[];
  /** カルテ側の傷病名。start は YYYY-MM-DD（分からないときは null） */
  diseases: { name: string; start: string | null }[];
};

export type ClaimQuery = {
  /** 診療年月 YYYY-MM */
  yearMonth: string;
  /** 患者の id。省けるのは、全件を持っているコネクタ（フィクスチャ）だけ */
  patientIds?: string[];
};

export interface PatientSource {
  getPatient(patientId: string): Promise<ConnectorPatient>;
}

export interface ClaimSource {
  getClaims(query: ClaimQuery): Promise<ConnectorClaims>;
}

export interface ChartSource {
  getChart(query: { patientId: string; yearMonth: string }): Promise<ConnectorChart>;
}

/** コネクタ。持っている能力だけを載せる */
export type Connector = {
  id: string;
  label: string;
  patient?: PatientSource;
  claims?: ClaimSource;
  chart?: ChartSource;
};

/** 請求を UkeFile の形にするのに要る、自院の情報（接続先からは取らない） */
export type ConnectSite = { clinic: UkeClinic; prefecture: string };

/** 患者の id・診療年月は URL やファイル名に入るので、文字種を先に確かめる */
export const PATIENT_ID = /^[A-Za-z0-9]{1,20}$/;
export const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertQuery(patientId: string | null, yearMonth: string | null): void {
  if (patientId !== null && !PATIENT_ID.test(patientId)) throw new Error("患者の id に使えない文字がある");
  if (yearMonth !== null && !YEAR_MONTH.test(yearMonth)) throw new Error("診療年月は YYYY-MM で指定する");
}

/** 診療年月の初日と末日（YYYY-MM-DD） */
export function monthRange(yearMonth: string): { start: string; end: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  return { start: `${yearMonth}-01`, end: `${yearMonth}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
}
