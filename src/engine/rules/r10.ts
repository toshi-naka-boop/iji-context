// R10 往診と訪問診療の同日・翌日（design.md §2-3-4・§11-5）と、緊急往診加算の対象患者。
// 算定した行だけで判定し、出来事は見ない。同じ日の 2 つの行の関係は、医療事務が確かめた 2 つの事実（sameDaySeparate・sameDayOushinAfterVisit）で決める（述語 sameDayOf）
import { billedOushinDays, billedVisitDays, sameDayOf, sameDayPairs, visitBillable, visitKubunOn } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { ClaimContext, Finding, NeedKey, Rule } from "../types";
import { addDays, finding, has } from "./util";

export function makeR10(c: RevisionConsts): Rule {
  const { kubun: OUSHIN, kinkyu: KINKYU } = c.oushin;
  /** 同じ日の組のうち、関係がその値と決まっている日 */
  const pairsOf = (ctx: ClaimContext, value: "same" | "after" | "not_after") =>
    sameDayPairs(ctx, c).filter((d) => {
      const s = sameDayOf(ctx, d);
      return s.known && s.value === value;
    });
  /** D：往診料の日の翌日で、訪問診療料を算定した日 */
  function dayAfterVisits(ctx: ClaimContext): string[] {
    const v = new Set(billedVisitDays(ctx, c));
    return billedOushinDays(ctx, c).map((d) => addDays(d, 1)).filter((d) => v.has(d));
  }
  return {
    id: "R10",
    kubun: [OUSHIN, KINKYU, ...c.visitKubun],
    reference: "C000 注1・C001 注1・注10（留意事項 C001 (11)(21)）",
    recordFindings: [],
    // kinkyu_not_eligible は申告しない：同じ日・翌日の訪問診療料の行があると文書提供を先に聞いて止まる（needs）ので、その行が対象外に移ると、指摘が新しく出る
    soundWhenPartial: [],
    appliesTo: (ctx) => has(ctx, OUSHIN) || has(ctx, KINKYU),
    needs(ctx) {
      const out: NeedKey[] = [];
      if (has(ctx, KINKYU)) out.push("emergencyEligible");
      // 文書提供を聞くのは、在支診で、往診料を立てられる同じ日（訪問診療のあとの往診）か翌日の組があるときだけ
      if (ctx.facility.zaishishin && (pairsOf(ctx, "after").length > 0 || dayAfterVisits(ctx).length > 0)) out.push("contactDocProvided");
      return out;
    },
    check(ctx) {
      const out: Finding[] = [];
      if (has(ctx, KINKYU) && ctx.facts.emergencyEligible.known && !ctx.facts.emergencyEligible.value)
        out.push(finding(this, "要件不足", [KINKYU], "kinkyu_not_eligible"));
      const refs = (days: string[]) => [...new Set(days.flatMap((d) => visitKubunOn(ctx, c, d)))];
      // A：関係が決まらない日ごとに、次に確かめる事実の情報不足を返す（背反とは言わない。ある日の答えはほかの日に効かない）
      for (const d of sameDayPairs(ctx, c)) {
        const s = sameDayOf(ctx, d);
        if (s.known === false)
          out.push({ ruleId: this.id, kind: "情報不足", lineRefs: [OUSHIN, ...refs([d])], missing: { target: "clerk", field: s.need, date: d }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      }
      // B：1 回の診療に両方。どちらを残すかは診療の中身で決まるので、片方を名指ししない
      const same = pairsOf(ctx, "same");
      if (same.length) out.push(finding(this, "背反", [OUSHIN, ...refs(same)], "same_encounter"));
      // 別々の診療でも、訪問診療のあとに急変などで行った往診でなければ、同じ日の往診料は立てられない（EM #7-8 改）
      if (pairsOf(ctx, "not_after").length) out.push(finding(this, "要件不足", [OUSHIN], "oushin_not_after_visit"));
      // C・D：制限の判定。算定しないのは訪問診療の費用（告示 C001 注10）
      if (visitBillable(ctx) !== true) {
        const c1 = pairsOf(ctx, "after");
        if (c1.length) out.push(finding(this, "要件不足", refs(c1), "same_day_as_visit"));
        const d1 = dayAfterVisits(ctx);
        if (d1.length) out.push(finding(this, "要件不足", refs(d1), "visit_day_after_oushin"));
      }
      return out;
    },
  };
}
