// 患者ごとに確かめた情報（要介護度・障害支援区分・別表第七・別表第八の二・別表第八の三のほかの状態・在宅酸素・居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者か）。
// 月をまたいで残る（design.md §6-1 の「単位：患者」の行）。その月・その日の出来事についての事実は、請求ごと（src/claim/facts.ts）に持つ。
// 判定はカルテ側の事実に、残した最新の値を重ねて使う。要介護度は認定の有効期間の終わりを過ぎたら「分からない」に戻す。
// 障害支援区分には有効期間を持たせない（EM に採用値がない。design.md §11-4・L-48）
import type { Facts, Residence } from "../engine/types";

export const PATIENT_FACT_KEYS = ["careLevel", "disabilitySupportLevel", "table7", "table8_2", "table8_3Other", "homeOxygen", "residence", "contactDocProvided", "emergencyEligible", "comprehensiveCare"] as const;
export type PatientFactKey = (typeof PATIENT_FACT_KEYS)[number];
export const FACT_SOURCES = ["介護保険証", "受給者証", "カルテ", "カルテ以外の記録", "医師に確認"] as const;
export const RESIDENCES: Residence[] = ["居宅", "施設入居等"];
export type FactSource = (typeof FACT_SOURCES)[number];

export type PatientFactInput = { key: PatientFactKey; value: number | boolean | Residence; source: FactSource; validUntil: string | null };
/** patientId は患者マスタの id（保険が変わっても同じ人に付いたままになる。FR-67・FR-121） */
export type PatientFact = PatientFactInput & { patientId: string; checkedAt: string; checkedBy: string };

const dateOf = (iso: string) => iso.slice(0, 10);

/** 期限が切れているか。now は時刻付き（+09:00）、validUntil は YYYY-MM-DD */
export const isExpired = (f: Pick<PatientFact, "validUntil">, now: string): boolean => f.validUntil !== null && dateOf(now) > f.validUntil;

/** 入力の検査。要介護度は 0〜5 の整数で、有効期間の終わりが要る。障害支援区分は 0〜6 の整数（0 は認定なし）、居住の場所は居宅か施設入居等、ほかは真偽値で、どれも期限は持たない */
export function validatePatientFact(f: PatientFactInput, now: string): void {
  if (!PATIENT_FACT_KEYS.includes(f.key)) throw new Error(`残せない項目: ${f.key}`);
  if (!FACT_SOURCES.includes(f.source)) throw new Error(`確かめた根拠が選べない値: ${f.source}`);
  if (f.key === "careLevel") {
    if (typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 0 || f.value > 5) throw new Error("要介護度は 0〜5 で選ぶ");
    if (!f.validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(f.validUntil)) throw new Error("要介護度には有効期間の終わりの日が要る");
    if (f.validUntil < dateOf(now)) throw new Error("有効期間の終わりが今日より前になっている");
  } else if (f.key === "disabilitySupportLevel") {
    if (typeof f.value !== "number" || !Number.isInteger(f.value) || f.value < 0 || f.value > 6) throw new Error("障害支援区分は 0〜6 で選ぶ");
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
  } else if (f.key === "residence") {
    if (!(RESIDENCES as unknown[]).includes(f.value)) throw new Error("居住の場所は、居宅か施設入居等から選ぶ");
    if (f.validUntil !== null) throw new Error(`${f.key} に期限は付けない`);
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
    else if (f.key === "careLevel" || f.key === "disabilitySupportLevel") out[f.key] = { known: true, value: f.value as number };
    else if (f.key === "residence") out.residence = { known: true, value: f.value as Residence };
    else out[f.key] = { known: true, value: f.value as boolean };
  }
  return out;
}
