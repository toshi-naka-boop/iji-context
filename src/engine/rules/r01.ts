// R01 管理料（在医総管・施設総管）の区分のうち、回数と注16 が理由の食い違いを指摘する（design.md §2-3-3）
// 重症が理由の食い違いは R02、族の取り違えは R16 の担当。1 つの行に出す区分の指摘は R01 か R02 のどちらか 1 件まで
import { expectedKanri, kanriKubun, kanriLines } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding } from "./util";

export function makeR01(c: RevisionConsts): Rule {
  const { from: TWICE, to: ONCE } = c.kanri.note16;
  return {
    id: "R01",
    kubun: [...kanriKubun(c), ...c.visitKubun],
    reference: "C002・C002-2（月の訪問診療料の回数による区分）・C002 注16",
    recordFindings: [],
    soundWhenPartial: [],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    // 注16 を聞くのは、回数 2 以上・重症でないと分かっていて、行がロ かニ のときだけ
    needs(ctx) {
      const t = expectedKanri(ctx, c).tier;
      const asks = t.known === false && t.need === "facility.note16Met" && kanriLines(ctx, c).some((l) => l.tier === TWICE || l.tier === ONCE);
      return asks ? ["facility.note16Met"] : [];
    },
    check(ctx) {
      const lines = kanriLines(ctx, c);
      const { visits, tier } = expectedKanri(ctx, c);
      const pick = (f: (t: string) => boolean) => lines.filter((l) => f(l.tier)).map((l) => l.kubun);
      if (visits === 0) return [finding(this, "区分誤り", lines.map((l) => l.kubun), "no_visit")];
      if (visits === 1) {
        const wrong = pick((t) => t !== ONCE);
        return wrong.length ? [finding(this, "区分誤り", wrong, "use_once")] : [];
      }
      // 回数 2 以上。重症（答えは イ）と、重症かどうかが不明のあいだは R02 の担当
      if (tier.known === false || tier.value === "イ") return [];
      if (tier.value === TWICE) {
        const wrong = pick((t) => t === ONCE);
        return wrong.length ? [finding(this, "区分誤り", wrong, "use_twice_or_more")] : [];
      }
      const wrong = pick((t) => t === TWICE);
      return wrong.length ? [finding(this, "区分誤り", wrong, "note16_once_rate")] : [];
    },
  };
}
