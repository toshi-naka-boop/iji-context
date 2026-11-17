// R06 特定疾患処方管理加算は主病が対象疾患のとき。対象外の主病（版の定数）では算定できない。処方日数に下限がある
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { eventsOf, fact, finding, has } from "./util";

export function makeR06(c: RevisionConsts): Rule {
  const { kubun: KUBUN, excludedDiseases: EXCLUDED, minDays } = c.tokutei;
  return {
    id: "R06",
    kubun: [KUBUN],
    reference: "F400 注4 特定疾患処方管理加算",
    appliesTo: (ctx) => has(ctx, KUBUN),
    needs: () => ["mainDisease"],
    check(ctx) {
      const out: Finding[] = [];
      const main = fact(ctx, "mainDisease");
      if (EXCLUDED.some((d) => main.includes(d))) out.push(finding(this, "要件不足", [KUBUN], "excluded_disease"));
      const rx = eventsOf(ctx, "prescription");
      if (rx.length > 0 && rx.every((e) => e.days < minDays)) out.push(finding(this, "要件不足", [KUBUN], "under_28_days"));
      return out;
    },
  };
}
