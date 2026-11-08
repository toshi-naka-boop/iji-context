// R01 在医総管の区分は同月の訪問診療の回数で決まる。訪問診療なしの在医総管は不可
import type { Rule } from "../types";
import { C001_VISIT, C002_KANRI, countOf, finding, present } from "./util";

export const r01: Rule = {
  id: "R01",
  kubun: [...C002_KANRI, ...C001_VISIT],
  reference: "C002 在宅時医学総合管理料（月の訪問回数による区分）",
  appliesTo: (ctx) => present(ctx, C002_KANRI).length > 0,
  needs: () => [],
  check(ctx) {
    const visits = countOf(ctx, C001_VISIT);
    const kanri = present(ctx, C002_KANRI);
    if (visits === 0) return [finding(this, "区分誤り", kanri, "no_visit")];
    if (visits >= 2 && kanri.includes("C002_2NI1")) return [finding(this, "区分誤り", ["C002_2NI1"], "use_twice_or_more")];
    if (visits === 1) {
      const wrong = kanri.filter((k) => k !== "C002_2NI1");
      if (wrong.length) return [finding(this, "区分誤り", wrong, "use_once")];
    }
    return [];
  },
};
