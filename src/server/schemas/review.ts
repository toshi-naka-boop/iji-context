// 査定・返戻の突き合わせの入力（spec FR-202 の I-1）。選べる値の一覧は src/review/reasons.ts（処理の側でも確かめる）
import { z } from "zod";
import { HUMAN_EXCLUSIONS, MISS_REASONS, RESULTS } from "../../review/reasons";
import { claimId } from "./cases";

/** 明細の id（取り込んだ明細の通し番号） */
export const reviewItemParams = z.strictObject({ id: z.string().regex(/^[1-9][0-9]{0,9}$/) });

/** 明細への操作：請求を選ぶ（null は当てられない）／行を選ぶ（コードか、その他・判定不能）／当て方を確かめる／対象外の印（null は外す）／判定 */
export const reviewItemBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("claim"), claimId: claimId.nullable() }),
  z.strictObject({ action: z.literal("line"), line: z.string().regex(/^([0-9]{9}|その他|判定不能)$/) }),
  z.strictObject({ action: z.literal("confirm") }),
  z.strictObject({ action: z.literal("exclude"), reason: z.enum(HUMAN_EXCLUSIONS).nullable() }),
  z.strictObject({ action: z.literal("judge"), result: z.enum(RESULTS), reason: z.enum(MISS_REASONS).optional(), finding: z.string().regex(/^[RGP]:[0-9]{1,4}$/).optional() }),
]);
