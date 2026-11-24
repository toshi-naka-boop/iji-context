// R21 ほかの医療機関との調整（design.md §18-4。v37 21c）：医療事務が確かめた ほかの機関の申告のとおりなら算定できない行。
// 指摘はすべて条件つき（前提の文から始まる）。申告がなければ判定せず、点検の範囲に「見ていません」と出す（careScopeNotes）
import { hasOthersScene, judgeOthers, R21_REFERENCE } from "../care-judge";
import { kanriKubun } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";

export function makeR21(c: RevisionConsts): Rule {
  const cc = c.care!;
  return {
    id: "R21",
    kubun: [...new Set([...kanriKubun(c), ...(c.visit2Kubun ?? []), cc.shiji])],
    reference: R21_REFERENCE,
    recordFindings: [],
    // ⑤⑥⑦ は行ごとに決まる（design.md §18-3 の「行ごとに決まる指摘の種類」）
    soundWhenPartial: ["kanri_one", "visit2_count", "visit2_6m", "shiji"],
    reads() {
      return this.kubun;
    },
    // 場面の区分の行があり、判定した（「見ていません」がない）か、指摘があるとき
    appliesTo: (ctx) => {
      if (!hasOthersScene(ctx, c)) return false;
      const j = judgeOthers(ctx, c);
      return j.findings.length > 0 || j.notes.size === 0;
    },
    needs: () => [],
    check: (ctx) => judgeOthers(ctx, c).findings,
  };
}
