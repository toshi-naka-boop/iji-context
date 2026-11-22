// 訪問カルテの入力。書いた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { FACT_KINDS } from "../../chart/extract";
import { ACT_CATEGORIES, CHILD_KINDS, MASTER_TABLES, MAX_LOOKUP, TABLE_KEYS } from "../../chart/acts";
import { YEAR_MONTH } from "../../demo/period";
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

/** 行ったこと（design.md §15-6・15-7）。当てたコードは処理の中で、診療年月の 1 枚に実在するかを確かめる */
const name200 = z.string().max(200);
const lookup = z.array(z.string().max(100)).max(MAX_LOOKUP);
const actMatch = z.strictObject({ tbl: z.enum(MASTER_TABLES), code: z.string().regex(/^\d{9}$/), name: name200, by: z.enum(["name", "alias", "candidate", "search"]) }).nullable().optional();
const actChild = z.strictObject({ kind: z.enum(CHILD_KINDS), written: name200, lookup, quantity: z.string().max(100).optional(), quote: z.string().max(MAX_CHART_TEXT), match: actMatch });
const act = z.strictObject({ category: z.enum(ACT_CATEGORIES), written: name200, lookup, quantity: z.string().max(100).optional(), quote: z.string().max(MAX_CHART_TEXT), with: z.array(actChild).max(20).optional(), match: actMatch });
/** 事実と行ったことを、確かめた 1 回の操作で保存する本文（POST /api/chart/acts） */
export const actsBody = z.strictObject({
  noteId: noteParams.shape.id,
  facts: confirmBody.shape.facts,
  acts: z.array(act).max(100),
  rx: z.array(z.strictObject({ quote: z.string().max(MAX_CHART_TEXT) })).max(20),
  rxChoice: z.enum(["outside", "inside", "unknown"]).nullable().optional(),
});
const ym = z.string().regex(YEAR_MONTH);
/** 候補（GET /api/chart/acts/candidates）。lookup は「|」で区切った語（5 個まで） */
export const candidatesQuery = z.strictObject({ table: z.enum(TABLE_KEYS), ym, written: z.string().min(1).max(200), lookup: z.string().max(600).optional() });
/** マスターを名前で探す（GET /api/masters/search） */
export const mastersSearchQuery = z.strictObject({ table: z.enum(TABLE_KEYS), ym, q: z.string().min(1).max(100) });

/** 選べる版の id（比較と試算。請求の判定に使う版と、比較用の版） */
export const revisionId = z.enum(SELECTABLE_REVISIONS.map((r) => r.id));
/** 算定プレビューの要選択への答え（pending の id → 選択肢の id）。クエリには JSON の文字列で載せる。rev を付けると、その版での試算 */
export const claimQuery = z.strictObject({ choices: z.string().max(2000).optional(), rev: revisionId.optional() });
/** 改定の比較。claimId を省くと、比べられる請求と選べる版だけを返す */
export const compareQuery = z.strictObject({ claimId: claimId.optional(), from: revisionId.optional(), to: revisionId.optional() });
export const claimChoices = z.record(z.string().max(80), z.string().max(40));

/**
 * 算定プレビューの「入力が要る」摘要欄の記載に入れる値（FR-176）。slot は導出の記載の場所（記載の表の行|導出が決めたコード|何件目）、code は 9 桁のコメントコード。
 * 値の形（コードの先頭 3 桁で決まる）は処理の中で確かめる（src/server/app/notes.ts の saveNoteComment）
 */
export const noteCommentBody = z.strictObject({
  slot: z.string().regex(/^[A-Za-z0-9-]{1,40}\|(\d{9})?\|\d{1,2}$/),
  code: z.string().regex(/^\d{9}$/),
  text: z.string().max(200),
});

export const soapBody = z.strictObject({ text: z.string().max(MAX_CHART_TEXT) });

/** base64 にした画像の長さの上限（5MB の画像は 4/3 倍に膨らむ） */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const imageBody = z.strictObject({ imageBase64: z.string().max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
