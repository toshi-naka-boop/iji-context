// R13 週の上限を超える訪問診療は、例外疾病（別表第七）か急性増悪のときだけ
import { maxVisitsPerWeek } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { eventsOf, fact, finding } from "./util";

export function makeR13(c: RevisionConsts): Rule {
  const LIMIT = c.weeklyVisitLimit;
  return {
    id: "R13",
    kubun: c.visitKubun,
    reference: "C001 注1（週3回限度）・別表第七",
    appliesTo: (ctx) => eventsOf(ctx, "visit").length > 0,
    needs: (ctx) => (maxVisitsPerWeek(ctx) > LIMIT ? ["table7", "acuteExacerbation"] : []),
    check(ctx) {
      if (maxVisitsPerWeek(ctx) <= LIMIT) return [];
      if (fact(ctx, "table7") || fact(ctx, "acuteExacerbation")) return [];
      return [finding(this, "要件不足", c.visitKubun.filter((k) => ctx.lines.some((l) => l.kubun === k)), "over_three_a_week")];
    },
  };
}
