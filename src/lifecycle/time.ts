// 時刻の形式（design.md §3、v16。round-11 C-52）
// 時刻はタイムゾーン付きの ISO 8601 に限る。比較は文字列ではなく時刻（ミリ秒）で行う

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** タイムゾーン付きの ISO 8601 でなければ例外 */
export function assertTime(s: unknown, label = "時刻"): asserts s is string {
  if (typeof s !== "string" || !ISO_TZ.test(s) || Number.isNaN(Date.parse(s))) {
    throw new Error(`${label}はタイムゾーン付きの ISO 8601 に限る（例 2025-03-10T10:00:00+09:00）: ${String(s)}`);
  }
}

/** 時刻をミリ秒にする（形式も確かめる） */
export function ms(s: string): number {
  assertTime(s);
  return Date.parse(s);
}

/** 同じ瞬間なら同じ文字列になる正規形（UTC）。reviewId や並べ替えに使う */
export function canonicalTime(s: string): string {
  return new Date(ms(s)).toISOString();
}

/** 日付（YYYY-MM-DD）を日本時間のその日 0 時にする。改定日・改選日用 */
export function jstDayStart(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日付の形式が違う（YYYY-MM-DD）: ${date}`);
  return `${date}T00:00:00+09:00`;
}

/** 日本時間での年 */
export function jstYear(s: string): number {
  return new Date(ms(s) + 9 * 3_600_000).getUTCFullYear();
}
