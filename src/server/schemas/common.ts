// スキーマの共通部品（spec FR-135）。オブジェクトは strictObject（知らない項目は断る）、文字列は長さの上限、配列は件数の上限を必ず付ける
import { z } from "zod";

/** id（問題・請求・提出結果など）。英数字と _ . : - だけ（パスの区切りや空白を通さない） */
export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/);
/** タイムゾーン付きの ISO 8601（src/lifecycle/time.ts の assertTime と同じ形） */
export const isoTime = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((s) => !Number.isNaN(Date.parse(s)));
/** [id] だけのパス */
export const idParams = z.strictObject({ id });
