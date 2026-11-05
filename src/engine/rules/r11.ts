// R11 検査判断料は区分ごとに月 1 回。BNP は生化学的検査(Ⅱ)判断料。外来迅速検体検査加算は訪問診療では立てない
import type { Finding, Rule } from "../types";
import { finding, has, lineOf } from "./util";

const D026 = ["D026_3", "D026_4", "D026_5"];

export const r11: Rule = {
  id: "R11",
  kubun: [...D026, "D008_18", "D_GAIRAI_JINSOKU"],
  reference: "D026 検体検査判断料・外来迅速検体検査加算",
  appliesTo: (ctx) => [...D026, "D008_18", "D_GAIRAI_JINSOKU"].some((k) => has(ctx, k)),
  needs: () => [],
  check(ctx) {
    const out: Finding[] = [];
    const over = D026.filter((k) => (lineOf(ctx, k)?.count ?? 0) > 1);
    if (over.length) out.push(finding(this, "背反", over, "judgement_once_a_month"));
    if (has(ctx, "D008_18") && !has(ctx, "D026_5")) out.push(finding(this, "区分誤り", ["D008_18"], "bnp_is_biochem2"));
    if (has(ctx, "D_GAIRAI_JINSOKU")) out.push(finding(this, "区分誤り", ["D_GAIRAI_JINSOKU"], "no_rapid_in_home"));
    return out;
  },
};
