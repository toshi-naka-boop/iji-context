// 医師確認の入力。回答者・承認者の名前は受け取らない（セッションの本人から決める。FR-134）
import { z } from "zod";
import { OTHER, UNDETERMINABLE } from "../../query/doctor-query";
import { MAX_DOCTOR_FREE_TEXT } from "../app/doctor-facts";
import { ABBREV_OPTIONS, MAX_ABBREV_OTHER } from "../app/doctor-abbrevs";
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
/** 略語の問いに答える（FR-211）。refs は答えた時点で並んでいた記載の参照（カルテの id・場所・指紋）。答えた人は受け取らない（セッションの本人から決める） */
export const doctorAbbrevBody = z.strictObject({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  token: z.string().regex(/^[A-Za-z]+[0-9]*$/).max(100),
  refs: z.array(z.string().regex(/^[1-9][0-9]{0,9}:(act|child|fact):[0-9a-f]{16}$/)).min(1).max(500),
  option: z.enum(ABBREV_OPTIONS),
  freeText: z.string().max(MAX_ABBREV_OTHER).optional(),
});
