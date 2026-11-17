// R01 在医総管の区分は同月の訪問診療の回数で決まる。訪問診療なしの在医総管は不可
import { visitCount } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, present } from "./util";

export function makeR01(c: RevisionConsts): Rule {
  return {
    id: "R01",
    kubun: [...c.kanri.all, ...c.visitKubun],
    reference: "C002 在宅時医学総合管理料（月の訪問回数による区分）",
    appliesTo: (ctx) => present(ctx, c.kanri.all).length > 0,
    needs: () => [],
    check(ctx) {
      const visits = visitCount(ctx, c);
      const kanri = present(ctx, c.kanri.all);
      if (visits === 0) return [finding(this, "区分誤り", kanri, "no_visit")];
      if (visits >= 2 && kanri.includes(c.kanri.once)) return [finding(this, "区分誤り", [c.kanri.once], "use_twice_or_more")];
      if (visits === 1) {
        const wrong = kanri.filter((k) => k !== c.kanri.once);
        if (wrong.length) return [finding(this, "区分誤り", wrong, "use_once")];
      }
      return [];
    },
  };
}
