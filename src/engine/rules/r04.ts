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
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    // 主たるもの 1 つ：指導管理料の区分の、2 つずつの組（通則2。電子点数表では同一月内の背反）
    covers: () => ({ kind: "背反", finding: "only_main", kubun: KANRI.flatMap((a, i) => KANRI.slice(i + 1).map((b) => [a, b])) }),
    appliesTo: (ctx) => present(ctx, KANRI).length > 0,
    needs: () => [],
    check(ctx) {
      const p = present(ctx, KANRI);
      return p.length >= 2 ? [finding(this, "背反", p, "only_main")] : [];
    },
  };
}
