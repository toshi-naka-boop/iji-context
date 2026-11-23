// 連携の境界の型（spec FR-104）。外部とのやり取りは、患者基本情報／請求／カルテ記載の 3 つに分ける。
// 画面と判定はこの型だけに依存し、個別の接続先（ORCA 形式・FHIR 形式・同梱の合成データ）を知らない
import type { PatientRecord } from "../patient/profile";
import { YEAR_MONTH } from "../demo/period";
import type { UkeFile } from "../uke/types";

/**
 * 患者基本情報。中身は患者マスタに取り込む形（src/patient/profile.ts の PatientRecord・CoverageInfo）そのもので、
 * コネクタはそれに接続先での患者の id を足すだけ（同じ趣旨の型を 2 つ持たない）
 */
export type ConnectorPatient = PatientRecord & {
  /** 接続先での患者の id（患者番号）。保険者番号に依存しない。患者マスタの id とは別 */
  patientId: string;
};

/** 対応表にない診療行為コードの行（判定の対象外。spec FR-111） */
export type UnmappedLine = { claimId: string; code: string; dates: string[] };

/** 診療年月の請求。files は UKE を読んだときと同じ形。unmapped が 1 件以上あるレセプトは合計を出さない */
export type ConnectorClaims = { files: UkeFile[]; unmapped: UnmappedLine[] };

/** 電子カルテのコード。rece＝レセ電コード、yj＝薬価基準収載医薬品コード、local＝接続先の独自コード（design.md §16-1） */
export type CodeRef = { system: "rece" | "yj" | "local"; value: string };
/** コードと表示名（別の欄。コードがなくても名称で当てられる。round-64 X-234） */
export type Coded = { code: CodeRef | null; name: string | null };

/** 種類ごとの能力の申告。unsupported＝接続先がこの種類を返さない。supported の items が空なら 0 件。gaps は欄ごとの欠けの数（手元の規則で数える。src/structured/read.ts） */
export type Part<T> = { status: "unsupported" } | { status: "supported"; items: T[]; gaps: Record<string, number> };

/** 訪問の記録。時刻は "HH:MM"（分の単位）。ref は接続先の行の id（患者の識別子ではない） */
export type Visit = { ref: string; date: string; start: string | null; end: string | null; kind: "訪問診療" | "往診" | null };
/** 処方のオーダー。refills はリフィルの回数（接続先が返すときだけ） */
export type RxOrder = { ref: string; date: string; place: "院内" | "院外" | null; refills: number | null; drugs: (Coded & { days: number | null; quantity: string | null })[] };
/** 注射・処置の実施（行為と、使った薬・材料） */
export type ProcRecord = { ref: string; date: string; act: Coded; count: number | null; items: (Coded & { kind: "薬" | "器材"; quantity: number | null; unit: string | null })[] };
/** 在宅療養の指示（指導管理の種類と機器） */
export type HomeCareOrder = { ref: string; kind: Coded; devices: (Coded & { startedOn: string | null; endedOn: string | null })[]; startedOn: string | null };

/** カルテの構造化データの 4 種類（design.md §16-1。AI には送らない） */
export type StructuredChart = { visits: Part<Visit>; orders: Part<RxOrder>; procedures: Part<ProcRecord>; homeCare: Part<HomeCareOrder> };
export const STRUCTURED_PARTS = ["visits", "orders", "procedures", "homeCare"] as const;
export type StructuredPart = (typeof STRUCTURED_PARTS)[number];

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
  /** 構造化データ（design.md §16-1）。ない＝4 種類とも unsupported とみなす（今のコネクタはそのまま通る） */
  structured?: StructuredChart;
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

/** 患者の id・診療年月は URL やファイル名に入るので、文字種を先に確かめる */
export const PATIENT_ID = /^[A-Za-z0-9]{1,20}$/;

export function assertQuery(patientId: string | null, yearMonth: string | null): void {
  if (patientId !== null && !PATIENT_ID.test(patientId)) throw new Error("患者の id に使えない文字がある");
  if (yearMonth !== null && !YEAR_MONTH.test(yearMonth)) throw new Error("診療年月は YYYY-MM で指定する");
}
