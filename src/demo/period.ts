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
} as const;
