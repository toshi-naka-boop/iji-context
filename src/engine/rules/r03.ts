// R03 包括的支援加算は、期待される管理料の区分が加算の対象（2ロ・2ニ）で、別表第八の三の状態（要介護度か障害支援区分が下限以上か、ほかの状態）に当たるとき。
// 満たさないのに立てれば要件不足、満たすのに立てなければ取り忘れ。対象かが決まらなければ情報不足。期待される区分がイ のとき（R02 の背反）・算定できない月・区分が未定の間は見ない
import { hokatsuEligible, hokatsuInScope, kanriKubun, kanriLines } from "../predicates";
import { mixedVisitMonth } from "../visit2";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, has } from "./util";

export function makeR03(c: RevisionConsts): Rule {
  const HOKATSU = c.hokatsu.kubun;
  return {
    id: "R03",
    kubun: [...kanriKubun(c), HOKATSU],
    reference: "C002 注10 包括的支援加算（C002-2 注5 で施設入居時等医学総合管理料に準用）",
    recordFindings: [],
    // not_eligible は申告しない：見る月か（hokatsuInScope）が訪問診療料の回数で決まり、重症で月 2 回以上の月は R02 の担当。訪問診療料の行が対象外に移ると、R03 が新しく出る
    soundWhenPartial: [],
    // 訪問診療料の回数で、期待される区分（加算を見る月か）が決まる（hokatsuInScope → expectedKanri）
    reads() {
      return [...new Set([...this.kubun, ...c.visitKubun])];
    },
    // (Ⅰ)1 と (Ⅰ)2 が同じ月にある月は判定不能（U-67。事情は R01 が聞く）
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0 && !mixedVisitMonth(ctx, c),
    needs(ctx) {
      if (!hokatsuInScope(ctx, c)) return [];
      const e = hokatsuEligible(ctx, c);
      return e.known === false ? [e.need] : [];
    },
    check(ctx) {
      if (!hokatsuInScope(ctx, c)) return [];
      const e = hokatsuEligible(ctx, c);
      const eligible = e.known === true && e.value;
      const claimed = has(ctx, HOKATSU);
      if (eligible && !claimed) return [finding(this, "取り忘れ", kanriLines(ctx, c).map((l) => l.kubun), "missing")];
      if (!eligible && claimed) return [finding(this, "要件不足", [HOKATSU], "not_eligible")];
      return [];
    },
  };
}
