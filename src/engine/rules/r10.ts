// R10 緊急往診加算は対象患者限定。訪問診療と同日の往診は原則不可。往診翌日の訪問診療は在支診以外不可
import type { Finding, Rule } from "../types";
import { addDays, eventsOf, finding, has } from "./util";

export const r10: Rule = {
  id: "R10",
  kubun: ["C000", "C000_N1_KINKYU", "C001_1I", "C001_1RO"],
  reference: "C000 注1・C001 注1・注10",
  appliesTo: (ctx) => has(ctx, "C000") || has(ctx, "C000_N1_KINKYU"),
  needs: (ctx) => (has(ctx, "C000_N1_KINKYU") ? ["emergencyEligible"] : []),
  check(ctx) {
    const out: Finding[] = [];
    if (has(ctx, "C000_N1_KINKYU") && ctx.facts.emergencyEligible.known && !ctx.facts.emergencyEligible.value)
      out.push(finding(this, "要件不足", ["C000_N1_KINKYU"], "kinkyu_not_eligible"));
    const visits = new Set(eventsOf(ctx, "visit").map((e) => e.date));
    const oushin = eventsOf(ctx, "oushin").map((e) => e.date);
    if (oushin.some((d) => visits.has(d))) out.push(finding(this, "要件不足", ["C000"], "same_day_as_visit"));
    if (!ctx.facility.zaishishin && oushin.some((d) => visits.has(addDays(d, 1))))
      out.push(finding(this, "要件不足", ["C001_1I"], "visit_day_after_oushin"));
    return out;
  },
};
