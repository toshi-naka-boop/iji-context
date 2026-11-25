// R10 往診と訪問診療の同日・翌日（design.md §2-3-4・§11-5）と、緊急往診加算の対象患者。
// 算定した行だけで判定し、出来事は見ない。同じ日の 2 つの行の関係は、医療事務が確かめた 2 つの事実（sameDaySeparate・sameDayOushinAfterVisit）で決める（述語 sameDayOf）
import { billedOushinDays, billedVisitDays, sameDayOf, sameDayPairs, visitBillable, visitBillableNeed, visitKubunOn } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { ClaimContext, Finding, NeedKey, Rule } from "../types";
import { addDays, finding, has, present } from "./util";
import { withVisit2Kubun } from "../visit2";

export function makeR10(c0: RevisionConsts): Rule {
  // 訪問診療料(Ⅰ)2 の日も、同じ日・翌日の往診の判定で訪問診療の日として数える（EM §2-14 W-122・W-123）。kubun は (Ⅰ)1 のまま（reads に (Ⅰ)2 を足す。visit2.ts）
  const c = withVisit2Kubun(c0);
  const OUSHIN = c.oushin.kubun;
  /** 緊急往診加算の、種別ごとの区分の全部（design.md §15-4。X-139）。対象患者かは種別で分かれない。種別が合っているかは R18 の担当 */
  const KINKYU = Object.values(c.oushin.kinkyu);
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
    kubun: [OUSHIN, ...KINKYU, ...c0.visitKubun],
    reference: "C000 注1・C001 注1・注10（留意事項 C001 (11)(21)）",
    recordFindings: [],
    // 緊急往診加算の対象患者かは、加算の行と確かめた事実だけで決まる（ほかの行に依らない）。同じ日・翌日の判定は、ほかの行の有無に依るので申告しない
    soundWhenPartial: ["kinkyu_not_eligible"],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => has(ctx, OUSHIN) || present(ctx, KINKYU).length > 0,
    // 不明な事実は、判定ごとに check が情報不足で返す（needs に入れると、1 つの不明でほかの判定まで止まる。
    // 文書提供が不明なだけで、確定している緊急往診加算の要件不足を見逃した：反証 round-28）
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const ask = (field: NeedKey, lineRefs: string[]): Finding => ({ ruleId: this.id, kind: "情報不足", lineRefs, missing: { target: "clerk", field }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      const kinkyu = present(ctx, KINKYU);
      if (kinkyu.length) {
        if (!ctx.facts.emergencyEligible.known) out.push(ask("emergencyEligible", kinkyu));
        else if (!ctx.facts.emergencyEligible.value) out.push(finding(this, "要件不足", kinkyu, "kinkyu_not_eligible"));
      }
      const refs = (days: string[]) => [...new Set(days.flatMap((d) => visitKubunOn(ctx, c, d)))];
      // A：関係が決まらない日ごとに、次に確かめる事実の情報不足を返す（背反とは言わない。ある日の答えはほかの日に効かない）
      for (const d of sameDayPairs(ctx, c)) {
        const s = sameDayOf(ctx, d);
        if (s.known === false)
          out.push({ ruleId: this.id, kind: "情報不足", lineRefs: [OUSHIN, ...refs([d])], missing: { target: "clerk", field: s.need, date: d }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      }
      // B：1 回の診療に両方。どちらを残すかは診療の中身で決まるので、片方を名指ししない
      const same = pairsOf(ctx, "same");
      // 指摘が関わる日（days）を持たせる（design.md §15-8。C-260・X-149）
      if (same.length) out.push({ ...finding(this, "背反", [OUSHIN, ...refs(same)], "same_encounter"), days: same });
      // 別々の診療でも、訪問診療のあとに急変などで行った往診でなければ、同じ日の往診料は立てられない（EM #7-8 改）
      const notAfter = pairsOf(ctx, "not_after");
      if (notAfter.length) out.push({ ...finding(this, "要件不足", [OUSHIN], "oushin_not_after_visit"), days: notAfter });
      // C・D：制限の判定。算定しないのは訪問診療の費用（告示 C001 注10）
      const c1 = pairsOf(ctx, "after");
      const d1 = dayAfterVisits(ctx);
      const billable = visitBillable(ctx);
      // 文書提供を聞くのは、在支診で、往診料を立てられる同じ日（訪問診療のあとの往診）か翌日の組があるときだけ
      if (billable === "unknown") {
        if (c1.length || d1.length) out.push(ask(visitBillableNeed(ctx), refs([...c1, ...d1])));
      } else if (billable === false) {
        if (c1.length) out.push({ ...finding(this, "要件不足", refs(c1), "same_day_as_visit"), days: c1 });
        if (d1.length) out.push({ ...finding(this, "要件不足", refs(d1), "visit_day_after_oushin"), days: d1 });
      }
      return out;
    },
  };
}
