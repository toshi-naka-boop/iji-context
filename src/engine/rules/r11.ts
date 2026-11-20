// R11 検査判断料は区分ごとに月 1 回。BNP は生化学的検査(Ⅱ)判断料。
// 訪問診療料・往診料の日の外来迅速検体検査加算は、当日中の結果説明と文書提供の記録を確かめる（算定できないとは断定しない。EM #7-9・#7-10）
import { billedOushinDays, billedVisitDays } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { ClaimContext, Finding, Rule } from "../types";
import { fact, finding, has, lineOf } from "./util";

export function makeR11(c: RevisionConsts): Rule {
  const { judgement: D026, bnp: BNP, bnpJudgement: BNP_JUDGEMENT, rapid: RAPID } = c.tests;
  /** 訪問診療料または往診料を算定した日に、外来迅速検体検査加算の行があるか */
  function rapidAtHome(ctx: ClaimContext): boolean {
    const home = new Set([...billedVisitDays(ctx, c), ...billedOushinDays(ctx, c)]);
    return (lineOf(ctx, RAPID)?.dates ?? []).some((d) => home.has(d));
  }
  return {
    id: "R11",
    kubun: [...D026, BNP, RAPID],
    reference: "D026 検体検査判断料・外来迅速検体検査加算（第3部第1節第1款 通則3）",
    recordFindings: [],
    appliesTo: (ctx) => [...D026, BNP, RAPID].some((k) => has(ctx, k)),
    needs: (ctx) => (rapidAtHome(ctx) ? ["rapidSameDayDocumented"] : []),
    check(ctx) {
      const out: Finding[] = [];
      const over = D026.filter((k) => (lineOf(ctx, k)?.count ?? 0) > 1);
      if (over.length) out.push(finding(this, "背反", over, "judgement_once_a_month"));
      if (has(ctx, BNP) && !has(ctx, BNP_JUDGEMENT)) out.push(finding(this, "区分誤り", [BNP], "bnp_is_biochem2"));
      if (rapidAtHome(ctx) && !fact(ctx, "rapidSameDayDocumented")) out.push(finding(this, "要件不足", [RAPID], "rapid_needs_same_day_doc"));
      return out;
    },
  };
}
