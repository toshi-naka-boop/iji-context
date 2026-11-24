// 医師確認の入力。回答者・承認者の名前は受け取らない（セッションの本人から決める。FR-134）
import { z } from "zod";
import { OTHER, UNDETERMINABLE } from "../../query/doctor-query";
import { MAX_DOCTOR_FREE_TEXT } from "../app/doctor-facts";
import { ABBREV_OPTIONS, MAX_ABBREV_OTHER, MAX_ABBREV_REFS, MAX_ABBREV_WRITE_IN } from "../app/doctor-abbrevs";
import { ABBREV_DICT_OPTIONS, ABBREV_NODICT_OPTIONS } from "../../chart/acts";
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
  // 問いの語は英字の略語だけ（名前そのものは聞かない。plan-fr211.md「規則の作り直し」2）
  token: z.string().regex(/^[A-Za-z]+[0-9]*$/).max(100),
  refs: z.array(z.string().regex(/^[1-9][0-9]{0,9}:text:[0-9a-f]{16}$/)).min(1).max(MAX_ABBREV_REFS),
  option: z.enum(ABBREV_OPTIONS),
  freeText: z.string().max(MAX_ABBREV_OTHER).optional(),
});
/** 事務がカルテの略語の扱いを選ぶ本文（POST /api/chart/abbrev-selections。FR-211 辞書方式の決め 2〜4）。選んだ人は受け取らない（セッションの本人から決める） */
export const abbrevSelectionBody = z.strictObject({
  noteId: z.string().regex(/^[1-9][0-9]{0,9}$/),
  token: z.string().regex(/^[A-Za-z]+[0-9]*$/).max(100),
  option: z.enum([...ABBREV_DICT_OPTIONS, ...ABBREV_NODICT_OPTIONS]),
  meaning: z.string().max(MAX_ABBREV_WRITE_IN).optional(),
  /** Lv.5 からだけ効く（Lv.4 までは辞書の略語を必ず医師確認に回す） */
  askDoctor: z.boolean().optional(),
});
/** そのカルテの略語のまとめを読む（GET /api/chart/abbrev-selections） */
export const abbrevSummaryQuery = z.strictObject({ noteId: z.string().regex(/^[1-9][0-9]{0,9}$/) });
