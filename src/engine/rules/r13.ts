// R13 週の上限を超える訪問診療料は、例外疾病（別表第七）か急性増悪のときだけ。算定した行の日で数える（算定しなかった訪問は数えない）
import { maxVisitsPerWeek, overLimitVisitDays } from "../predicates";
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
    // 情報不足が関わる日は、上限を超えた週の訪問診療料の算定日の全部（design.md §15-8。C-272）
    needDays: (ctx) => overLimitVisitDays(ctx, c),
    check(ctx) {
      if (maxVisitsPerWeek(ctx, c) <= LIMIT) return [];
      if (fact(ctx, "table7") || fact(ctx, "acuteExacerbation")) return [];
      // 関わる日は、上限を超えた週の訪問診療料の算定日の全部（週が 2 つ超えていれば両方。design.md §15-8。C-260）
      return [{ ...finding(this, "要件不足", present(ctx, c.visitKubun), "over_three_a_week"), days: overLimitVisitDays(ctx, c) }];
    },
  };
}
