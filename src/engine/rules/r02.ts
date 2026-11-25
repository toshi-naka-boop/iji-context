// R02 別表第八の二（在宅酸素療法中など）の患者に月 2 回以上なら重症区分（2イ）。期待される区分がイ のとき、包括的支援加算は付けない
// 見るのは訪問診療料が 2 回以上の月だけ（重症区分は月 2 回以上が条件。design.md §2-3-3）
import { expectedKanri, kanriKubun, kanriLines } from "../predicates";
import { mixedVisitMonth } from "../visit2";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { fact, finding, has } from "./util";

export function makeR02(c: RevisionConsts): Rule {
  const HOKATSU = c.hokatsu.kubun;
  return {
    id: "R02",
    kubun: [...kanriKubun(c), HOKATSU],
    reference: "C002 2イ・C002-2 2イ（別に厚生労働大臣が定める状態＝別表第八の二）・C002 注10",
    recordFindings: [],
    soundWhenPartial: [],
    // 訪問診療料の回数で、見る月か（月 2 回以上）が決まる（expectedKanri）
    reads() {
      return [...new Set([...this.kubun, ...c.visitKubun])];
    },
    // (Ⅰ)1 と (Ⅰ)2 が同じ月にある月は判定不能（U-67。事情は R01 が聞く）
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0 && !mixedVisitMonth(ctx, c),
    needs: (ctx) => (expectedKanri(ctx, c).visits >= 2 ? ["table8_2"] : []),
    check(ctx) {
      if (expectedKanri(ctx, c).visits < 2) return [];
      const out: Finding[] = [];
      const lines = kanriLines(ctx, c);
      const severe = fact(ctx, "table8_2");
      const notSevereTier = lines.filter((l) => l.tier !== "イ").map((l) => l.kubun);
      const severeTier = lines.filter((l) => l.tier === "イ").map((l) => l.kubun);
      if (severe && notSevereTier.length) out.push(finding(this, "区分誤り", notSevereTier, "use_severe"));
      if (!severe && severeTier.length) out.push(finding(this, "区分誤り", severeTier, "not_severe"));
      // 加算は、行の区分ではなく期待される区分（イ）で判定する
      if (severe && has(ctx, HOKATSU)) out.push(finding(this, "背反", [HOKATSU], "severe_with_hokatsu"));
      return out;
    },
  };
}
