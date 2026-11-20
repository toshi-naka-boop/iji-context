// 症例・照合・UKE の入力。請求 id は形を固定する（ファイルは請求 id から組み立てず、src/server/app/case-files.ts の表を引く）
import { z } from "zod";
import { UKE_TRIAL_REVISIONS } from "../../engine/revisions";
import { UKE_CLAIM_ID } from "../../uke/limits";
import { id } from "./common";

/**
 * 請求 id（同梱の症例は 症例の番号-診療年月。例 K1-2026-10）。アップロードした UKE のレセプトも開けるよう、
 * UKE の読み込みと同じ文字種（英数字とハイフン、20 文字まで）で受ける。パスの区切りや . は通さない
 */
export const claimId = z.string().regex(UKE_CLAIM_ID);
/** 日付（YYYY-MM-DD） */
export const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

// 本人の id は受け取らない（セッションから決める）
export const crosscheckQuery = z.strictObject({ claimId, asOf: date.optional() });
export const crosscheckBody = z.strictObject({ claimId, ruleId: id, asOf: date.optional() });

/** 取り込んだファイルの指定（内容のハッシュ。消す操作で使う） */
export const uploadParams = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
/** 取り込んだレセプトの試算で選ぶ版（design.md §11-12）。コードの表を持つ版の id だけ（比較用の版は選べない） */
export const ukeTrialQuery = z.strictObject({ rev: z.enum(UKE_TRIAL_REVISIONS.map((r) => r.id)) });
/** 取り込む UKE のファイル名（用意してある 2 本のどれかは、処理の側で確かめる）。見本のダウンロードのクエリも同じ形 */
export const ukeBody = z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}\.UKE$/) });
