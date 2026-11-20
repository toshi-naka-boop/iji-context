// R16 管理料の族（在医総管／施設総管）は、患者の居住の場所で決まる。族だけを見る（区分は R01・R02）
import { kanriKubun, kanriLines } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { fact, finding } from "./util";

export function makeR16(c: RevisionConsts): Rule {
  return {
    id: "R16",
    kubun: kanriKubun(c),
    reference: "C002 注1・C002-2 注1・注2（留意事項 C002 (3)）",
    recordFindings: [],
    soundWhenPartial: [],
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    needs: () => ["residence"],
    check(ctx) {
      const out: Finding[] = [];
      const expected = c.kanri.familyOf[fact(ctx, "residence")];
      const wrong = kanriLines(ctx, c).filter((l) => l.family !== expected).map((l) => l.kubun);
      if (wrong.length) out.push(finding(this, "区分誤り", wrong, expected === "施設総管" ? "use_shisetsu" : "use_zaii"));
      return out;
    },
  };
}
