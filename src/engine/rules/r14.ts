// R14 在宅移行早期加算（EM #7-7）：退院後に在宅療養を始めた患者で、在医総管の算定開始月から3月以内・退院から1年以内
// 再入院→再退院で数え直す例外は、退院イベントのうち最も新しいものを起点にすることで扱う
import type { ClaimContext, Rule } from "../types";
import { C002_KANRI, addDays, eventsOf, finding, has, present } from "./util";

/** "YYYY-MM" の差（月数） */
function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function eligible(ctx: ClaimContext): boolean {
  const start = eventsOf(ctx, "kanriStart").map((e) => e.month).sort().at(-1);
  const discharge = eventsOf(ctx, "discharge").map((e) => e.date).sort().at(-1);
  if (!start || !discharge) return false;
  const months = monthDiff(start, ctx.yearMonth);
  // 算定開始月を 1 か月目として 3 か月目まで
  if (months < 0 || months > 2) return false;
  // 退院から 1 年以内（請求月の初日で判定）
  return `${ctx.yearMonth}-01` <= addDays(discharge, 365);
}

export const r14: Rule = {
  id: "R14",
  kubun: [...C002_KANRI, "C002_N4_IKOU"],
  reference: "C002 注4 在宅移行早期加算（留意事項 (16)(17)）",
  appliesTo: (ctx) => present(ctx, C002_KANRI).length > 0,
  needs: () => [],
  check(ctx) {
    const ok = eligible(ctx);
    const claimed = has(ctx, "C002_N4_IKOU");
    if (ok && !claimed) return [finding(this, "取り忘れ", present(ctx, C002_KANRI), "missing")];
    if (!ok && claimed) return [finding(this, "要件不足", ["C002_N4_IKOU"], "not_eligible")];
    return [];
  },
};
