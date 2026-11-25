// R14 在宅移行早期加算（EM #7-7）：退院後に在宅療養を始めた患者で、管理料（在医総管・施設総管）の算定開始月から所定の月数以内・退院から所定の日数以内
import { ikouEligible, kanriKubun, kanriLines } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, has } from "./util";

export function makeR14(c: RevisionConsts): Rule {
  const IKOU = c.ikou.kubun;
  return {
    id: "R14",
    kubun: [...kanriKubun(c), IKOU],
    reference: "C002 注4 在宅移行早期加算（留意事項 (16)(17)。C002-2 注5 で準用）",
    // 退院と管理料の算定開始月の出来事で決める
    recordFindings: ["missing", "not_eligible"],
    soundWhenPartial: [],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    needs: () => [],
    check(ctx) {
      const ok = ikouEligible(ctx, c);
      const claimed = has(ctx, IKOU);
      if (ok && !claimed) return [finding(this, "取り忘れ", kanriLines(ctx, c).map((l) => l.kubun), "missing")];
      if (!ok && claimed) return [finding(this, "要件不足", [IKOU], "not_eligible")];
      return [];
    },
  };
}
