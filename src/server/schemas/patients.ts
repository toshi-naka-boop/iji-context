// 患者ごとに確かめた情報の入力。確かめた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { FACT_SOURCES, PATIENT_FACT_KEYS } from "../../patient/facts";
import { claimId, date } from "./cases";

export const claimParams = z.strictObject({ claimId });

/** 形だけをここで確かめる。項目ごとの決まり（要介護度は 0〜5 と有効期間の終わりの日、ほかは期限なし）は src/patient/facts.ts の validatePatientFact が確かめて文言を返す */
export const factBody = z.strictObject({
  fact: z.strictObject({
    key: z.enum(PATIENT_FACT_KEYS),
    value: z.union([z.number().int().min(0).max(5), z.boolean()]),
    source: z.enum(FACT_SOURCES),
    validUntil: date.nullable(),
  }),
});
