// R12 在宅医療DX情報活用加算は医療情報取得加算・医療DX推進体制整備加算と同月併算定不可
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, has, present } from "./util";

export function makeR12(c: RevisionConsts): Rule {
  const { kubun: DX, conflicts: CONFLICT } = c.dx;
  return {
    id: "R12",
    kubun: [DX, ...CONFLICT],
    reference: "C001 注13 在宅医療DX情報活用加算",
    appliesTo: (ctx) => has(ctx, DX),
    needs: () => [],
    check(ctx) {
      const p = present(ctx, CONFLICT);
      return p.length ? [finding(this, "背反", [DX, ...p], "same_month")] : [];
    },
  };
}
