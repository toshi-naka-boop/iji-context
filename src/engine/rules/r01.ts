// R01 管理料（在医総管・施設総管）の区分のうち、回数と注16 が理由の食い違いを指摘する（design.md §2-3-3）
// 重症が理由の食い違いは R02、族の取り違えは R16、施設の種別の取り違えは R18 の担当。1 つの行に出す区分の指摘は R01 か R02 のどちらか 1 件まで。
// 区分（イ・ロ・ニ）だけを比べ、行の種別・人数の区分は見ない（§0-12・§15-4）
import { expectedKanri, kanriKubun, kanriKubunOf, kanriLines } from "../predicates";
import type { KubunDef, RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding } from "./util";

/**
 * points は版の点数表。「申告だけを根拠に点数の高い区分へ直さない」（design.md §15-4。round-51 C-251）で、直し先と行の点数を比べるのに使う（比べるだけで、指摘の文に点数は入れない）。
 * どちらかの点数が版にない（点数未収載）ときは高い側とみなす
 */
export function makeR01(c: RevisionConsts, points: Record<string, KubunDef>): Rule {
  const { from: TWICE, to: ONCE } = c.kanri.note16;
  const pointOf = (k: string) => (Object.hasOwn(points, k) ? points[k].points : null);
  /** 直し先が行より点数の高い区分か（点数未収載なら高い側とみなす） */
  const higher = (to: string, from: string) => {
    const a = pointOf(to);
    const b = pointOf(from);
    return a === null || b === null || a > b;
  };
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
        const wrong = lines.filter((l) => l.tier === ONCE);
        if (!wrong.length) return [];
        // 注16 の基準を満たすことが施設の申告（届出の裏付けがない）だけから来ているときは、点数の高い区分へ直す区分誤りを出さず、申告と請求の食い違いの情報不足にする
        const byDeclaration = c.kanri.note16.enabled && ctx.facilityBasis?.note16Met === "declaration";
        const conflict = byDeclaration ? wrong.filter((l) => higher(kanriKubunOf(c, l.family, l.grade, TWICE) ?? "", l.kubun)) : [];
        const rest = wrong.filter((l) => !conflict.includes(l)).map((l) => l.kubun);
        const out: Finding[] = [];
        if (conflict.length)
          out.push({ ruleId: this.id, kind: "情報不足", lineRefs: conflict.map((l) => l.kubun), missing: { target: "clerk", field: "facility.note16Met" }, messageKey: `${this.id}.declaration_conflict`, reference: this.reference });
        if (rest.length) out.push(finding(this, "区分誤り", rest, "use_twice_or_more"));
        return out;
      }
      const wrong = pick((t) => t === TWICE);
      return wrong.length ? [finding(this, "区分誤り", wrong, "note16_once_rate")] : [];
    },
  };
}
