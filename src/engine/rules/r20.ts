// R20 介護保険との調整（design.md §18-3。v37 21c）：医療事務が確かめた介護の申告（住まいの種別・短期入所・要介護・要支援の認定）のとおりなら算定できない行。
// 指摘はすべて条件つき（前提の文から始まる）。申告のない・分からない場面は判定せず、点検の範囲に「見ていません」と出す（careScopeNotes）
import { hasCareScene, judgeCare, R20_REFERENCE } from "../care-judge";
import { kanriKubun } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";

export function makeR20(c: RevisionConsts): Rule {
  const cc = c.care!;
  const visits = [...c.visitKubun, ...(c.visit2Kubun ?? [])];
  return {
    id: "R20",
    kubun: [...new Set([...visits, ...kanriKubun(c), cc.renkei])],
    reference: R20_REFERENCE,
    recordFindings: [],
    // 行ごとに決まる種類だけ（①・④ と、② の訪問診療料の算定日ごとの指摘）。管理料の指摘と「利用前 30 日の訪問がない」で決まる指摘は入れない（見えない行に左右される。X-350）
    soundWhenPartial: ["tokuyou", "rouken", "renkei", "ryouyou_visit", "seikatsu_haichi_visit", "shoutaki_haichi_visit", "seikatsu_30", "shoutaki_30"],
    reads() {
      return this.kubun;
    },
    // 場面の区分の行があり、判定した（「見ていません」がない）か、指摘があるとき
    appliesTo: (ctx) => {
      if (!hasCareScene(ctx, c)) return false;
      const j = judgeCare(ctx, c);
      return j.findings.length > 0 || j.notes.size === 0;
    },
    needs: () => [],
    check: (ctx) => judgeCare(ctx, c).findings,
  };
}
