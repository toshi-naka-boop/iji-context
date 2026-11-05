// R12 在宅医療DX情報活用加算は医療情報取得加算・医療DX推進体制整備加算と同月併算定不可
import type { Rule } from "../types";
import { finding, has, present } from "./util";

const CONFLICT = ["A_IRYOJOHO", "A_DXSUISHIN"];

export const r12: Rule = {
  id: "R12",
  kubun: ["C001_N13_DX", ...CONFLICT],
  reference: "C001 注13 在宅医療DX情報活用加算",
  appliesTo: (ctx) => has(ctx, "C001_N13_DX"),
  needs: () => [],
  check(ctx) {
    const c = present(ctx, CONFLICT);
    return c.length ? [finding(this, "背反", ["C001_N13_DX", ...c], "same_month")] : [];
  },
};
