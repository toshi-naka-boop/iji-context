// R07 処方箋料は内服 7 種類以上で 32 点（区分 2）。それ以外は 60 点（区分 3）
import type { Finding, Rule } from "../types";
import { eventsOf, finding, has } from "./util";

export const r07: Rule = {
  id: "R07",
  kubun: ["F400_3", "F400_2"],
  reference: "F400 処方箋料 2・3",
  appliesTo: (ctx) => has(ctx, "F400_3") || has(ctx, "F400_2"),
  needs: () => [],
  check(ctx) {
    const out: Finding[] = [];
    const many = eventsOf(ctx, "prescription").some((e) => e.oralKinds >= 7);
    if (many && has(ctx, "F400_3")) out.push(finding(this, "区分誤り", ["F400_3"], "use_seven_or_more"));
    if (!many && has(ctx, "F400_2")) out.push(finding(this, "区分誤り", ["F400_2"], "not_seven_or_more"));
    return out;
  },
};
