// R10 緊急往診加算は対象患者限定。訪問診療と同日の往診は原則不可。往診翌日の訪問診療は在支診以外不可
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { addDays, eventsOf, finding, has } from "./util";

export function makeR10(c: RevisionConsts): Rule {
  const { kubun: OUSHIN, kinkyu: KINKYU } = c.oushin;
  return {
    id: "R10",
    kubun: [OUSHIN, KINKYU, ...c.visitKubun],
    reference: "C000 注1・C001 注1・注10",
    appliesTo: (ctx) => has(ctx, OUSHIN) || has(ctx, KINKYU),
    needs: (ctx) => (has(ctx, KINKYU) ? ["emergencyEligible"] : []),
    check(ctx) {
      const out: Finding[] = [];
      if (has(ctx, KINKYU) && ctx.facts.emergencyEligible.known && !ctx.facts.emergencyEligible.value)
        out.push(finding(this, "要件不足", [KINKYU], "kinkyu_not_eligible"));
      const visits = new Set(eventsOf(ctx, "visit").map((e) => e.date));
      const oushin = eventsOf(ctx, "oushin").map((e) => e.date);
      if (oushin.some((d) => visits.has(d))) out.push(finding(this, "要件不足", [OUSHIN], "same_day_as_visit"));
      if (!ctx.facility.zaishishin && oushin.some((d) => visits.has(addDays(d, 1))))
        out.push(finding(this, "要件不足", [c.visitKubun[0]], "visit_day_after_oushin"));
      return out;
    },
  };
}
