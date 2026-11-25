// R16 管理料の族（在医総管／施設総管）は、患者の居住の場所で決まる。族だけを見る（区分は R01・R02）。
// 居住の場所の 2 値は住まいの種別から導く（design.md §18-2）。2 値に当たらない月・月の途中で住まいが変わった月・短期入所生活介護などの月は黙る（familySilence。R20 が見る）。
// 分からないときに聞くのは住まいの種別（C-494）
import { familySilence } from "../care-scope";
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
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0 && familySilence(ctx) === null,
    needs: (ctx) => (ctx.facts.residence.known ? [] : ["residenceType"]),
    check(ctx) {
      const out: Finding[] = [];
      const expected = c.kanri.familyOf[fact(ctx, "residence")];
      const wrong = kanriLines(ctx, c).filter((l) => l.family !== expected).map((l) => l.kubun);
      if (wrong.length) out.push(finding(this, "区分誤り", wrong, expected === "施設総管" ? "use_shisetsu" : "use_zaii"));
      return out;
    },
  };
}
