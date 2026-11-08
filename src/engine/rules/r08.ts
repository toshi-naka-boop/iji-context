// R08 ベースアップ評価料(Ⅰ) 訪問診療時は 28 点。往診のみの日は再診時等 2 点
import type { Finding, Rule } from "../types";
import { eventsOf, finding, lineOf } from "./util";

const O100 = ["O100_3I", "O100_3RO", "O100_SAISHIN"];

export const r08: Rule = {
  id: "R08",
  kubun: O100,
  reference: "O100 外来・在宅ベースアップ評価料(Ⅰ)",
  appliesTo: (ctx) => O100.some((k) => lineOf(ctx, k)),
  needs: () => [],
  check(ctx) {
    const out: Finding[] = [];
    const visitDays = new Set(eventsOf(ctx, "visit").map((e) => e.date));
    const homeDays = (lineOf(ctx, "O100_3I")?.dates ?? []).concat(lineOf(ctx, "O100_3RO")?.dates ?? []);
    if (homeDays.some((d) => !visitDays.has(d))) out.push(finding(this, "区分誤り", ["O100_3I"], "oushin_only_day"));
    const saishinDays = lineOf(ctx, "O100_SAISHIN")?.dates ?? [];
    if (saishinDays.some((d) => visitDays.has(d))) out.push(finding(this, "区分誤り", ["O100_SAISHIN"], "use_visit_28"));
    return out;
  },
};
