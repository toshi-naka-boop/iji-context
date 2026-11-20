// R04 在宅療養指導管理料は主たる 1 つのみ。材料加算は各々算定可
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, present } from "./util";

export function makeR04(c: RevisionConsts): Rule {
  const KANRI = c.shidoKanriKubun;
  return {
    id: "R04",
    kubun: KANRI,
    reference: "第2部第2節第1款 通則2（主たる指導管理の所定点数のみ）",
    recordFindings: [],
    soundWhenPartial: ["only_main"],
    appliesTo: (ctx) => present(ctx, KANRI).length > 0,
    needs: () => [],
    check(ctx) {
      const p = present(ctx, KANRI);
      return p.length >= 2 ? [finding(this, "背反", p, "only_main")] : [];
    },
  };
}
