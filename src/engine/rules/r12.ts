// R12 在宅医療DX情報活用加算：併算定できない加算と同月に立てない。区分（加算1・加算2）は届出の区分に合わせる
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, present } from "./util";

export function makeR12(c: RevisionConsts): Rule {
  const { tiers: TIERS, conflicts: CONFLICT } = c.dx;
  const DX = Object.values(TIERS);
  return {
    id: "R12",
    kubun: [...DX, ...CONFLICT],
    reference: "C001 注13 在宅医療DX情報活用加算",
    recordFindings: [],
    soundWhenPartial: ["same_month"],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    // 在宅医療DX情報活用加算と、同じ月に併算定できない加算の組（注13。電子点数表では同一月内の背反）。届出の区分との食い違い（dx_tier・dx_not_notified）は、表に載らないので申告しない
    covers: () => ({ kind: "背反", finding: "same_month", kubun: DX.flatMap((d) => CONFLICT.map((x) => [d, x])) }),
    appliesTo: (ctx) => present(ctx, DX).length > 0,
    needs: () => ["facility.dxTier"],
    check(ctx) {
      const out: Finding[] = [];
      const dx = present(ctx, DX);
      const p = present(ctx, CONFLICT);
      if (p.length) out.push(finding(this, "背反", [...dx, ...p], "same_month"));
      const tier = ctx.facility.dxTier;
      if (!tier.known) return out;
      if (tier.value === "なし") out.push(finding(this, "要件不足", dx, "dx_not_notified"));
      else {
        const wrong = dx.filter((k) => k !== TIERS[tier.value as "1" | "2"]);
        if (wrong.length) out.push(finding(this, "区分誤り", wrong, "dx_tier"));
      }
      return out;
    },
  };
}
