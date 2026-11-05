// R02 在宅酸素中など別表第八の二は重症区分 4,585。3,685 は過少。重症区分に包括的支援加算は付けない
import type { Finding, Rule } from "../types";
import { fact, finding, has } from "./util";

export const r02: Rule = {
  id: "R02",
  kubun: ["C002_2I1", "C002_2RO1", "C002_N10_HOKATSU"],
  reference: "C002 2イ（別に厚生労働大臣が定める状態＝別表第八の二）・注10",
  appliesTo: (ctx) => has(ctx, "C002_2I1") || has(ctx, "C002_2RO1"),
  needs: () => ["table8_2"],
  check(ctx) {
    const out: Finding[] = [];
    const severe = fact(ctx, "table8_2");
    if (severe && has(ctx, "C002_2RO1")) out.push(finding(this, "区分誤り", ["C002_2RO1"], "use_severe"));
    if (!severe && has(ctx, "C002_2I1")) out.push(finding(this, "区分誤り", ["C002_2I1"], "not_severe"));
    if (has(ctx, "C002_2I1") && has(ctx, "C002_N10_HOKATSU"))
      out.push(finding(this, "背反", ["C002_2I1", "C002_N10_HOKATSU"], "severe_with_hokatsu"));
    return out;
  },
};
