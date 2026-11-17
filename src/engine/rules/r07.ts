// R07 処方箋料は内服の種類数が閾値以上で区分 2。それ以外は区分 3
import { rxManyOral } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, has } from "./util";

export function makeR07(c: RevisionConsts): Rule {
  const { many: MANY, other: OTHER } = c.rx;
  return {
    id: "R07",
    kubun: [OTHER, MANY],
    reference: "F400 処方箋料 2・3",
    appliesTo: (ctx) => has(ctx, OTHER) || has(ctx, MANY),
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const many = rxManyOral(ctx, c);
      if (many && has(ctx, OTHER)) out.push(finding(this, "区分誤り", [OTHER], "use_seven_or_more"));
      if (!many && has(ctx, MANY)) out.push(finding(this, "区分誤り", [MANY], "not_seven_or_more"));
      return out;
    },
  };
}
