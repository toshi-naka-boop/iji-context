// 患者ごとに医療事務が確かめた情報（要介護度・別表第七・別表第八の二・在宅酸素）。
// 判定はカルテ側の事実に、残した最新の値を重ねて使う。要介護度は認定の有効期間の終わりを過ぎたら「分からない」に戻す
import type { Facts } from "../engine/types";
import type { UkePatient } from "../uke/types";

export const PATIENT_FACT_KEYS = ["careLevel", "table7", "table8_2", "homeOxygen"] as const;
export type PatientFactKey = (typeof PATIENT_FACT_KEYS)[number];
export const FACT_SOURCES = ["介護保険証", "カルテ", "医師に確認"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export type PatientFactInput = { key: PatientFactKey; value: number | boolean; source: FactSource; validUntil: string | null };
export type PatientFact = PatientFactInput & { patientKey: string; checkedAt: string; checkedBy: string };

/** 患者の見分け方：UKE の保険者番号と被保険者番号（合成データ） */
export const patientKeyOf = (p: UkePatient): string => `${p.insurer.number}-${p.insurer.no}`;

const dateOf = (iso: string) => iso.slice(0, 10);

/** 期限が切れているか。now は時刻付き（+09:00）、validUntil は YYYY-MM-DD */
export const isExpired = (f: Pick<PatientFact, "validUntil">, now: string): boolean => f.validUntil !== null && dateOf(now) > f.validUntil;

/** 入力の検査。要介護度は 0〜5 の整数で、有効期間の終わりが要る。ほかは真偽値で、期限は持たない */
export function validatePatientFact(f: PatientFactInput, now: string): void {
  if (!PATIENT_FACT_KEYS.includes(f.key)) throw new Error(`残せない項目: ${f.key}`);
  if (!FACT_SOURCES.includes(f.source)) throw new Error(`確かめた根拠が選べない値: ${f.source}`);
  if (f.key === "careLevel") {
    if (typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 0 || f.value > 5) throw new Error("要介護度は 0〜5 で選ぶ");
    if (!f.validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(f.validUntil)) throw new Error("要介護度には有効期間の終わりの日が要る");
    if (f.validUntil < dateOf(now)) throw new Error("有効期間の終わりが今日より前になっている");
  } else {
    if (typeof f.value !== "boolean") throw new Error(`${f.key} は当たる・当たらないで選ぶ`);
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  }
}

/** カルテ側の事実に、残した最新の値を重ねる。期限切れの値は「分からない」にする */
export function applyPatientFacts(facts: Facts, latest: PatientFact[], now: string): Facts {
  const out: Facts = { ...facts };
  for (const f of latest) {
    if (isExpired(f, now)) out[f.key] = { known: false };
    else if (f.key === "careLevel") out.careLevel = { known: true, value: f.value as number };
    else out[f.key] = { known: true, value: f.value as boolean };
  }
  return out;
}
