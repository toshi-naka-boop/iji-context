// 医師確認の入力。回答者・承認者の名前は受け取らない（セッションの本人から決める。FR-134）
import { z } from "zod";
import { OTHER, UNDETERMINABLE } from "../../query/doctor-query";
import { MAX_DOCTOR_FREE_TEXT } from "../app/doctor-facts";
import { claimId, date } from "./cases";

/** 医師確認の id（src/query/doctor-query.ts の createQuery が作る形。記録のファイル名になるので、形を固定する） */
export const doctorQueryParams = z.strictObject({ id: z.string().regex(/^q-[0-9a-f]{12}$/) });
export const answerBody = z.strictObject({ option: z.string().min(1).max(100), freeText: z.string().max(500).optional() });
/** 確かめてほしい項目に、決められなかった答えを残す（その他・判定不能だけ。決まった答えは事実の入口に残す）。答えた人は受け取らない（セッションの本人から決める） */
export const doctorFactBody = z.strictObject({
  claimId,
  key: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
  date: date.nullable(),
  option: z.enum([OTHER, UNDETERMINABLE]),
  freeText: z.string().max(MAX_DOCTOR_FREE_TEXT).optional(),
});
