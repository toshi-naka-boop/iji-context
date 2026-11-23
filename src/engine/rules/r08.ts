// R08 ベースアップ評価料(Ⅰ)：訪問診療料を算定した日は訪問診療時の区分。往診料だけの日は再診時等の区分。
// 通常と注5 の区分を合わせて見る（通常か注5 かは R18 の担当。design.md §15-4・§0-12）
import { baseUpDayKubun } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Rule } from "../types";
import { makeDayTypeRule } from "./day-type";

export function makeR08(c: RevisionConsts): Rule {
  const { visit, revisit } = baseUpDayKubun(c);
  return makeDayTypeRule(
    { id: "R08", visitKubun: visit, otherKubun: revisit, overlapKey: c.baseUp.overlapKey, reference: "O001 外来・在宅ベースアップ評価料(Ⅰ)（留意事項 (3)〜(5)）" },
    c,
  );
}
