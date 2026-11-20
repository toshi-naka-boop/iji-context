// 訪問カルテの入力。書いた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { FACT_KINDS } from "../../chart/extract";
import { SELECTABLE_REVISIONS } from "../../engine/revisions";
import { MAX_IMAGE_BYTES } from "../../chart/image";
import { MAX_CHART_TEXT } from "../../chart/limits";
import { claimId } from "./cases";

export { MAX_CHART_TEXT };
const field = z.string().max(MAX_CHART_TEXT);

export const chartBody = z.strictObject({
  claimId,
  kind: z.enum(["訪問診療", "往診"]),
  note: z.strictObject({ s: field, o: field, a: field, p: field, rx: field }),
});
/** カルテを書く本文（JSON）の上限（バイト）：5 欄 × 上限の字数 × 3 バイト（日本語の UTF-8）と、JSON の枠・改行の分 */
export const CHART_BODY_BYTES = 5 * MAX_CHART_TEXT * 3 + 4096;

/** カルテの id（chart_notes の連番） */
export const noteParams = z.strictObject({ id: z.string().regex(/^[1-9][0-9]{0,9}$/) });
export const confirmBody = z.strictObject({
  facts: z.array(z.strictObject({ kind: z.enum(FACT_KINDS), value: z.string().max(200), quote: z.string().max(MAX_CHART_TEXT) })).max(50),
});

/** 選べる版の id（比較と試算。請求の判定に使う版と、比較用の版） */
export const revisionId = z.enum(SELECTABLE_REVISIONS.map((r) => r.id));
/** 算定プレビューの要選択への答え（pending の id → 選択肢の id）。クエリには JSON の文字列で載せる。rev を付けると、その版での試算 */
export const claimQuery = z.strictObject({ choices: z.string().max(2000).optional(), rev: revisionId.optional() });
/** 改定の比較。claimId を省くと、比べられる請求と選べる版だけを返す */
export const compareQuery = z.strictObject({ claimId: claimId.optional(), from: revisionId.optional(), to: revisionId.optional() });
export const claimChoices = z.record(z.string().max(80), z.string().max(40));

export const soapBody = z.strictObject({ text: z.string().max(MAX_CHART_TEXT) });

/** base64 にした画像の長さの上限（5MB の画像は 4/3 倍に膨らむ） */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const imageBody = z.strictObject({ imageBase64: z.string().max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
