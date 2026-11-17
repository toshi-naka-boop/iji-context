// R05 在医総管の月に包括される項目を別に立てない。院外処方なら処方箋を交付しない場合の加算は不可。
// 処方箋料とそれに付く加算も投薬の費用として包括される（EM #7-6、疑義解釈 令和8年 その2 問66）
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { eventsOf, finding, has, present } from "./util";

export function makeR05(c: RevisionConsts): Rule {
  /** 在医総管に包括される項目のうち、区分表にあるもの */
  const BUNDLED = c.bundled.kubun;
  const NO_RX = c.bundled.noRxAddition;
  return {
    id: "R05",
    kubun: [...c.kanri.all, ...BUNDLED, NO_RX],
    reference: "C002 留意事項（所定点数に含まれる項目）・注（処方箋を交付しない場合）",
    appliesTo: (ctx) => present(ctx, c.kanri.all).length > 0,
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
