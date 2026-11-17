// R03 包括的支援加算は、期待される管理料の区分が加算の対象（2ロ・2ニ）で、要介護度が下限以上のとき。
// 満たさないのに立てれば要件不足、満たすのに立てなければ取り忘れ。期待される区分がイ のとき（R02 の背反）・算定できない月・区分が未定の間は見ない
import { hokatsuEligible, hokatsuInScope, kanriKubun, kanriLines } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, has } from "./util";

export function makeR03(c: RevisionConsts): Rule {
  const HOKATSU = c.hokatsu.kubun;
  return {
    id: "R03",
    kubun: [...kanriKubun(c), HOKATSU],
    reference: "C002 注10 包括的支援加算（C002-2 注5 で施設入居時等医学総合管理料に準用）",
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    needs: (ctx) => (hokatsuInScope(ctx, c) ? ["careLevel"] : []),
    check(ctx) {
      if (!hokatsuInScope(ctx, c)) return [];
      const eligible = hokatsuEligible(ctx, c);
      const claimed = has(ctx, HOKATSU);
      if (eligible && !claimed) return [finding(this, "取り忘れ", kanriLines(ctx, c).map((l) => l.kubun), "missing")];
      if (!eligible && claimed) return [finding(this, "要件不足", [HOKATSU], "not_eligible")];
      return [];
    },
  };
}
