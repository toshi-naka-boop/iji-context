// R15 物価対応料：訪問診療料を算定した日は訪問診療時の区分。往診料だけの日は再診時等の区分（R08 と同じ規則）
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { makeDayTypeRule } from "./day-type";

export function makeR15(c: RevisionConsts): Rule {
  return makeDayTypeRule(
    { id: "R15", visitKubun: c.price.visit, otherKubun: [c.price.revisit], overlapKey: c.price.overlapKey, reference: "O100 外来・在宅物価対応料（留意事項 (3)(4)）" },
    c,
  );
}
