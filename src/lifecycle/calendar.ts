// 改定日・改選日（design.md §4-3）。日付は config/calendar.json から読む
// 改定日・改選日は日本時間のその日 0 時（v16 §3）。返す値もタイムゾーン付きの ISO 8601
import { jstDayStart, jstYear, ms } from "./time";

export type YearlyDate = { parity: "even" | "odd"; monthDay: string };

export type Calendar = {
  /** 診療報酬改定 */
  revision: YearlyDate;
  /** 支払基金の改選 */
  shiharaiKikin: YearlyDate;
  /** 国保連の改選日（都道府県別の日付一覧。null・未設定は「発火しない」） */
  kokuhoren: Record<string, string[] | null>;
};

/** 2 つの日時文字列の前後比較（a が b より後なら true） */
export function isAfter(a: string, b: string): boolean {
  return ms(a) > ms(b);
}

/** 毎年（偶数年／奇数年）の月日のうち、now 以前で直近のもの。なければ null */
export function latestYearly(d: YearlyDate, now: string): string | null {
  const year = jstYear(now);
  const want = d.parity === "even" ? 0 : 1;
  for (let y = year; y >= year - 2; y--) {
    if (((y % 2) + 2) % 2 !== want) continue;
    const cand = jstDayStart(`${y}-${d.monthDay}`);
    if (ms(cand) <= ms(now)) return cand;
  }
  return null;
}

/** 直近の診療報酬改定日 */
export function latestRevision(cal: Calendar, now: string): string | null {
  return latestYearly(cal.revision, now);
}

/** 地域層知識の直近の改選日。国保連で日付未設定（null・都道府県なし）なら null */
export function latestReappointment(
  cal: Calendar,
  payer: "支払基金" | "国保連" | undefined,
  prefecture: string | undefined,
  now: string,
): string | null {
  if (payer === "支払基金") return latestYearly(cal.shiharaiKikin, now);
  if (payer === "国保連") {
    const dates = prefecture ? cal.kokuhoren[prefecture] : null;
    if (!dates) return null;
    const past = dates.map(jstDayStart).filter((d) => ms(d) <= ms(now)).sort((a, b) => ms(a) - ms(b));
    return past.length ? past[past.length - 1] : null;
  }
  return null;
}
