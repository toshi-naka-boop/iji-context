// デモの日付の置き場（design.md §0-11・§3-1）。年月の直書きは config/demo.json とここに寄せる
import demo from "../../config/demo.json";

export const period = {
  /** 基準月：合成レセプトの診療年月（"YYYY-MM"） */
  yearMonth: demo.yearMonth,
  /** 請求月（基準月の診療分を請求する月） */
  billingMonth: demo.billingMonth,
  /** デモの時計の初期値（基準月の中） */
  clockStart: demo.clockStart,
  /** 種の日付（SEED_AT）：基準月の初日 */
  seedAt: `${demo.yearMonth}-01T00:00:00+09:00`,
  /** データの版の印。データの置き場（SQLite と knowledge/ の組）に、作ったときの印を残す（design.md §10 段 2） */
  dataset: demo.dataset,
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** 基準月の n 日（"YYYY-MM-DD"） */
export const dayOf = (n: number): string => `${demo.yearMonth}-${pad(n)}`;
/** 基準月の n 日を、画面の文に出す形で（例 "10/14"） */
export const mdOf = (n: number): string => `${Number(demo.yearMonth.slice(5))}/${n}`;
/** 基準月の症例の請求 id（例 claimIdOf("K1")） */
export const claimIdOf = (caseNo: string): string => `${caseNo}-${demo.yearMonth}`;
/** 基準月から months か月ずらした月（"YYYY-MM"。負なら前の月） */
export function monthFrom(months: number): string {
  const [y, m] = demo.yearMonth.split("-").map(Number);
  const i = y * 12 + (m - 1) + months;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
/** 基準月から months か月ずらした月の n 日（"YYYY-MM-DD"） */
export const dateFrom = (months: number, day: number): string => `${monthFrom(months)}-${pad(day)}`;

// 基準月によらない年月の小道具（どの診療年月にも使う）

/** 診療年月（"YYYY-MM"。月は 01〜12）の形 */
export const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 診療年月（YYYY-MM）の初日と末日（YYYY-MM-DD） */
export function monthRange(yearMonth: string): { start: string; end: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${yearMonth}-01`, end: `${yearMonth}-${pad(last)}` };
}
