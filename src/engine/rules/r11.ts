// R11 検査判断料は区分ごとに月 1 回。BNP は生化学的検査(Ⅱ)判断料。外来迅速検体検査加算は訪問診療では立てない
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, has, lineOf } from "./util";

export function makeR11(c: RevisionConsts): Rule {
  const { judgement: D026, bnp: BNP, bnpJudgement: BNP_JUDGEMENT, rapid: RAPID } = c.tests;
  return {
    id: "R11",
    kubun: [...D026, BNP, RAPID],
    reference: "D026 検体検査判断料・外来迅速検体検査加算",
    appliesTo: (ctx) => [...D026, BNP, RAPID].some((k) => has(ctx, k)),
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const over = D026.filter((k) => (lineOf(ctx, k)?.count ?? 0) > 1);
      if (over.length) out.push(finding(this, "背反", over, "judgement_once_a_month"));
      if (has(ctx, BNP) && !has(ctx, BNP_JUDGEMENT)) out.push(finding(this, "区分誤り", [BNP], "bnp_is_biochem2"));
      if (has(ctx, RAPID)) out.push(finding(this, "区分誤り", [RAPID], "no_rapid_in_home"));
      return out;
    },
  };
}
