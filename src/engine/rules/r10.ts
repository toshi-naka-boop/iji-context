// R10 往診と訪問診療の同日・翌日（design.md §2-3-4）と、緊急往診加算の対象患者。
// 算定した行だけで判定し、出来事は見ない。同じ日の 2 つの行が別々の診療かは、医療事務が確かめた事実（sameDaySeparate）で決める
import { billedOushinDays, billedVisitDays, sameDayPairs, visitBillable, visitKubunOn } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { ClaimContext, Finding, NeedKey, Rule } from "../types";
import { addDays, finding, has } from "./util";

export function makeR10(c: RevisionConsts): Rule {
  const { kubun: OUSHIN, kinkyu: KINKYU } = c.oushin;
  /** その日の答え（真＝別々の診療／偽＝1 回の診療／undefined＝確かめていない） */
  const separateOn = (ctx: ClaimContext, day: string): boolean | undefined => (ctx.facts.sameDaySeparate.known ? ctx.facts.sameDaySeparate.value[day] : undefined);
  /** C：別々の診療と確かめた同じ日 */
  const separateDays = (ctx: ClaimContext) => sameDayPairs(ctx, c).filter((d) => separateOn(ctx, d) === true);
  /** D：往診料の日の翌日で、訪問診療料を算定した日 */
  function dayAfterVisits(ctx: ClaimContext): string[] {
    const v = new Set(billedVisitDays(ctx, c));
    return billedOushinDays(ctx, c).map((d) => addDays(d, 1)).filter((d) => v.has(d));
  }
  return {
    id: "R10",
    kubun: [OUSHIN, KINKYU, ...c.visitKubun],
    reference: "C000 注1・C001 注1・注10（留意事項 C001 (11)(21)）",
    appliesTo: (ctx) => has(ctx, OUSHIN) || has(ctx, KINKYU),
    needs(ctx) {
      const out: NeedKey[] = [];
      if (has(ctx, KINKYU)) out.push("emergencyEligible");
      // 文書提供を聞くのは、在支診で、別々と確かめた同じ日か翌日の組があるときだけ
      if (ctx.facility.zaishishin && (separateDays(ctx).length > 0 || dayAfterVisits(ctx).length > 0)) out.push("contactDocProvided");
      return out;
    },
    check(ctx) {
      const out: Finding[] = [];
      if (has(ctx, KINKYU) && ctx.facts.emergencyEligible.known && !ctx.facts.emergencyEligible.value)
        out.push(finding(this, "要件不足", [KINKYU], "kinkyu_not_eligible"));
      const refs = (days: string[]) => [...new Set(days.flatMap((d) => visitKubunOn(ctx, c, d)))];
      const pairs = sameDayPairs(ctx, c);
      // A：別々の診療かを確かめていない日ごとに、情報不足を返す（背反とは言わない）
      for (const d of pairs.filter((x) => separateOn(ctx, x) === undefined))
        out.push({ ruleId: this.id, kind: "情報不足", lineRefs: [OUSHIN, ...refs([d])], missing: { target: "clerk", field: "sameDaySeparate", date: d }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      // B：1 回の診療に両方。どちらを残すかは診療の中身で決まるので、片方を名指ししない
      const same = pairs.filter((d) => separateOn(ctx, d) === false);
      if (same.length) out.push(finding(this, "背反", [OUSHIN, ...refs(same)], "same_encounter"));
      // C・D：制限の判定。算定しないのは訪問診療の費用（告示 C001 注10）
      if (visitBillable(ctx) !== true) {
        const c1 = separateDays(ctx);
        if (c1.length) out.push(finding(this, "要件不足", refs(c1), "same_day_as_visit"));
        const d1 = dayAfterVisits(ctx);
        if (d1.length) out.push(finding(this, "要件不足", refs(d1), "visit_day_after_oushin"));
      }
      return out;
    },
  };
}
