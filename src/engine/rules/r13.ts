// R13 週 3 回を超える訪問診療は、例外疾病（別表第七）か急性増悪のときだけ
import type { ClaimContext, Rule } from "../types";
import { C001_VISIT, eventsOf, fact, finding } from "./util";

/** 週（日曜始まり）ごとの訪問回数の最大値。週の区切りは暦週とした（推測。留意事項で要確認） */
function maxVisitsPerWeek(ctx: ClaimContext): number {
  const perWeek = new Map<string, number>();
  for (const v of eventsOf(ctx, "visit")) {
    const d = new Date(`${v.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const key = d.toISOString().slice(0, 10);
    perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...perWeek.values());
}

export const r13: Rule = {
  id: "R13",
  kubun: C001_VISIT,
  reference: "C001 注1（週3回限度）・別表第七",
  appliesTo: (ctx) => eventsOf(ctx, "visit").length > 0,
  needs: (ctx) => (maxVisitsPerWeek(ctx) > 3 ? ["table7", "acuteExacerbation"] : []),
  check(ctx) {
    if (maxVisitsPerWeek(ctx) <= 3) return [];
    if (fact(ctx, "table7") || fact(ctx, "acuteExacerbation")) return [];
    return [finding(this, "要件不足", C001_VISIT.filter((k) => ctx.lines.some((l) => l.kubun === k)), "over_three_a_week")];
  },
};
