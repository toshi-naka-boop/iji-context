// R13 週の上限を超える訪問診療料は、例外疾病（別表第七）か急性増悪のときだけ。算定した行の日で数える（算定しなかった訪問は数えない）
import { maxVisitsPerWeek } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { fact, finding, present } from "./util";

export function makeR13(c: RevisionConsts): Rule {
  const LIMIT = c.weeklyVisitLimit;
  return {
    id: "R13",
    kubun: c.visitKubun,
    reference: "C001 注1（週3回限度）・別表第七",
    recordFindings: [],
    soundWhenPartial: [],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => present(ctx, c.visitKubun).length > 0,
    // 別表第七に当たると分かっていれば、急性増悪は聞かない（答えで結論が変わらない）
    needs: (ctx) => {
      if (maxVisitsPerWeek(ctx, c) <= LIMIT) return [];
      const t7 = ctx.facts.table7;
      return t7.known && t7.value ? [] : ["table7", "acuteExacerbation"];
    },
    check(ctx) {
      if (maxVisitsPerWeek(ctx, c) <= LIMIT) return [];
      if (fact(ctx, "table7") || fact(ctx, "acuteExacerbation")) return [];
      return [finding(this, "要件不足", present(ctx, c.visitKubun), "over_three_a_week")];
    },
  };
}
