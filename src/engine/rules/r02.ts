// R02 在宅酸素中など別表第八の二は重症区分。月 2 回以上の区分では過少。重症区分に包括的支援加算は付けない
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { fact, finding, has } from "./util";

export function makeR02(c: RevisionConsts): Rule {
  const { severe: SEVERE, twice: TWICE } = c.kanri;
  const HOKATSU = c.hokatsu.kubun;
  return {
    id: "R02",
    kubun: [SEVERE, TWICE, HOKATSU],
    reference: "C002 2イ（別に厚生労働大臣が定める状態＝別表第八の二）・注10",
    appliesTo: (ctx) => has(ctx, SEVERE) || has(ctx, TWICE),
    needs: () => ["table8_2"],
    check(ctx) {
      const out: Finding[] = [];
      const severe = fact(ctx, "table8_2");
      if (severe && has(ctx, TWICE)) out.push(finding(this, "区分誤り", [TWICE], "use_severe"));
      if (!severe && has(ctx, SEVERE)) out.push(finding(this, "区分誤り", [SEVERE], "not_severe"));
      if (has(ctx, SEVERE) && has(ctx, HOKATSU)) out.push(finding(this, "背反", [SEVERE, HOKATSU], "severe_with_hokatsu"));
      return out;
    },
  };
}
