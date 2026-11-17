// R03 包括的支援加算は要介護度が下限以上かつ重症区分以外。満たさないのに立てれば要件不足、満たすのに立てなければ取り忘れ
import { hokatsuEligible } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { finding, has, present } from "./util";

export function makeR03(c: RevisionConsts): Rule {
  const HOKATSU = c.hokatsu.kubun;
  return {
    id: "R03",
    kubun: [...c.kanri.all, HOKATSU],
    reference: "C002 注10 包括的支援加算",
    appliesTo: (ctx) => present(ctx, c.kanri.all).length > 0,
    needs: () => ["careLevel", "table8_2"],
    check(ctx) {
      const eligible = hokatsuEligible(ctx, c);
      const claimed = has(ctx, HOKATSU);
      if (eligible && !claimed) return [finding(this, "取り忘れ", present(ctx, c.kanri.all), "missing")];
      if (!eligible && claimed) return [finding(this, "要件不足", [HOKATSU], "not_eligible")];
      return [];
    },
  };
}
