// 症例・照合・UKE の入力。請求 id はファイル名の組み立てに使われる（src/server/app/cases.ts・notes.ts）ので、形を固定する
import { z } from "zod";
import { id } from "./common";

/** 請求 id（症例の番号-診療年月。例 K1-2025-03）。英数字とハイフンだけで、パスの区切りや . を通さない */
export const claimId = z.string().regex(/^K[0-9]{1,3}-[0-9]{4}-(0[1-9]|1[0-2])$/);
/** 日付（YYYY-MM-DD） */
export const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

// 本人の id は受け取らない（セッションから決める）
export const crosscheckQuery = z.strictObject({ claimId, asOf: date.optional() });
export const crosscheckBody = z.strictObject({ claimId, ruleId: id, asOf: date.optional() });

/** 取り込む UKE のファイル名（用意してある 2 本のどれかは、処理の側で確かめる） */
export const ukeBody = z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,40}\.UKE$/) });
