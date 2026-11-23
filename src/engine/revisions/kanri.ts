// 管理料の区分の表を、族×種別ごとの [イ, ロ, ニ] の並びから行の一覧にする（design.md §15-4。版のファイルが使う）
import type { FacilityGrade } from "../types";
import type { KanriFamily, KanriRow, KanriTierKey } from "./types";

const TIERS: KanriTierKey[] = ["イ", "ロ", "ニ"];

export function kanriRows(table: Record<KanriFamily, Partial<Record<FacilityGrade, [string, string, string]>>>): KanriRow[] {
  return (Object.entries(table) as [KanriFamily, Partial<Record<FacilityGrade, [string, string, string]>>][]).flatMap(([family, grades]) =>
    (Object.entries(grades) as [FacilityGrade, [string, string, string]][]).flatMap(([grade, kubuns]) => kubuns.map((kubun, i) => ({ kubun, family, grade, tier: TIERS[i] }))),
  );
}
