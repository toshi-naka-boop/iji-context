// R05 管理料（在医総管・施設総管）の月に包括される項目を別に立てない。院外処方なら処方箋を交付しない場合の加算は不可。
// 処方箋料とそれに付く加算も投薬の費用として包括される（EM #7-6、疑義解釈 令和8年 その2 問66）
import { kanriKubun, kanriLines } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { eventsOf, finding, has, present } from "./util";

export function makeR05(c: RevisionConsts): Rule {
  /** 管理料に包括される項目のうち、区分表にあるもの */
  const BUNDLED = c.bundled.kubun;
  const NO_RX = c.bundled.noRxAddition;
  return {
    id: "R05",
    kubun: [...kanriKubun(c), ...BUNDLED, NO_RX],
    reference: "C002 注2・注3、留意事項（所定点数に含まれる項目）。C002-2 注5 で準用",
    // 処方の出来事を読む指摘（記録のない請求では出さない。包括項目の bundled は行だけで決まる）
    recordFindings: ["no_rx_addition_with_rx"],
    soundWhenPartial: ["bundled"],
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const bundled = present(ctx, BUNDLED);
      if (bundled.length) out.push(finding(this, "背反", bundled, "bundled"));
      if (has(ctx, NO_RX) && eventsOf(ctx, "prescription").length > 0) out.push(finding(this, "背反", [NO_RX], "no_rx_addition_with_rx"));
      return out;
    },
  };
}
