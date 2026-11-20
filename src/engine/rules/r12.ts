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
