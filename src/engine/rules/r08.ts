// R08 ベースアップ評価料(Ⅰ)：訪問診療料を算定した日は訪問診療時の区分。往診料だけの日は再診時等の区分
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { makeDayTypeRule } from "./day-type";

export function makeR08(c: RevisionConsts): Rule {
  return makeDayTypeRule(
    { id: "R08", visitKubun: c.baseUp.visit, otherKubun: c.baseUp.revisit, overlapKey: c.baseUp.overlapKey, reference: "O001 外来・在宅ベースアップ評価料(Ⅰ)（留意事項 (3)〜(5)）" },
    c,
  );
}
