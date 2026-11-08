// R03 包括的支援加算は要介護 3 以上かつ重症区分以外。満たさないのに立てれば要件不足、満たすのに立てなければ取り忘れ
import type { Rule } from "../types";
import { C002_KANRI, fact, finding, has, present } from "./util";

export const r03: Rule = {
  id: "R03",
  kubun: [...C002_KANRI, "C002_N10_HOKATSU"],
  reference: "C002 注10 包括的支援加算",
  appliesTo: (ctx) => present(ctx, C002_KANRI).length > 0,
  needs: () => ["careLevel", "table8_2"],
  check(ctx) {
    const eligible = fact(ctx, "careLevel") >= 3 && !fact(ctx, "table8_2");
    const claimed = has(ctx, "C002_N10_HOKATSU");
    if (eligible && !claimed) return [finding(this, "取り忘れ", present(ctx, C002_KANRI), "missing")];
    if (!eligible && claimed) return [finding(this, "要件不足", ["C002_N10_HOKATSU"], "not_eligible")];
    return [];
  },
};
