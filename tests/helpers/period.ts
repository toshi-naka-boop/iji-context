// テストの年月・日付・請求 id の置き場。値は config/demo.json（src/demo/period.ts）から作り、テストに年月を直書きしない
import { claimIdOf, dateFrom, dayOf, monthFrom, period } from "../../src/demo/period";

/** 基準月（"YYYY-MM"） */
export const YM = period.yearMonth;
/** 基準月の n 日（"YYYY-MM-DD"） */
export const day = dayOf;
/** 基準月の症例の請求 id（claimId("K1")） */
export const claimId = claimIdOf;
/** 基準月の n 日の時刻（タイムゾーン付き。既定は 9 時） */
export const at = (n: number, time = "09:00:00"): string => `${dayOf(n)}T${time}+09:00`;
/** 基準月から months か月ずらした月（"YYYY-MM"）と、その月の n 日 */
export const month = monthFrom;
export const dateIn = dateFrom;
