// R08 ベースアップ評価料(Ⅰ) 訪問診療の日は訪問診療時の区分。往診のみの日は再診時等の区分
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { eventsOf, finding, lineOf } from "./util";

export function makeR08(c: RevisionConsts): Rule {
  const { visit: VISIT, revisit: REVISIT } = c.baseUp;
  const O100 = [...VISIT, REVISIT];
  return {
    id: "R08",
    kubun: O100,
    reference: "O100 外来・在宅ベースアップ評価料(Ⅰ)",
    appliesTo: (ctx) => O100.some((k) => lineOf(ctx, k)),
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const visitDays = new Set(eventsOf(ctx, "visit").map((e) => e.date));
      const homeDays = VISIT.flatMap((k) => lineOf(ctx, k)?.dates ?? []);
      if (homeDays.some((d) => !visitDays.has(d))) out.push(finding(this, "区分誤り", [VISIT[0]], "oushin_only_day"));
      const saishinDays = lineOf(ctx, REVISIT)?.dates ?? [];
      if (saishinDays.some((d) => visitDays.has(d))) out.push(finding(this, "区分誤り", [REVISIT], "use_visit_28"));
      return out;
    },
  };
}
