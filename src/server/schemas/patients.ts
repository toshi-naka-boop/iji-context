// 患者ごとに確かめた情報の入力。確かめた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { FACT_SOURCES, PATIENT_FACT_KEYS } from "../../patient/facts";
import { COVERAGE_SOURCES } from "../../patient/profile";
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

/**
 * 保険・公費の加入情報の確認入力。確かめた根拠（何を見て確かめたか）は選択。番号・負担割合は、直すときだけ送る。
 * 有効期間の終わりの null は「期限の定めなし」。桁数・検証番号は断らずに受け取り、患者情報チェック（P01）が指摘として返す
 */
export const coverageBody = z.strictObject({
  coverage: z.strictObject({
    coverageId: z.string().regex(/^C[0-9]{1,12}$/),
    source: z.enum(COVERAGE_SOURCES),
    payerNumber: z.string().regex(/^[0-9]{1,12}$/).optional(),
    memberNo: z.string().regex(/^[0-9]{1,12}$/).optional(),
    burdenRatio: z.number().min(0).max(1).optional(),
    validFrom: date.nullable(),
    validUntil: date.nullable(),
  }),
});
