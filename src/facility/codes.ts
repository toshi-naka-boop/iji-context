// 施設基準コードの読み方の例外と、施設の種別（design.md §15-2・§15-3。EM §2-11 表 4・R8-48）。
// どのコードも config/shisetsu-kijun.json（表 4 の写し）にあることを tests/facility/shisetsu-kijun.test.ts が縛る
import type { FacilityGrade } from "../engine/types";

/** 在宅療養支援病院のコード。診療所は持たない（J-2）。申告によらず「持たない」 */
export const HOSPITAL_CODES = ["3057", "3058", "3169"] as const;

/** 施設の種別の選択肢（申告の `grade` の choice）。code は持つ施設基準コード、grade は判定に渡す種別 */
export const GRADE_CHOICES = [
  { id: "solo_beds", label: "機能強化型 単独型・病床あり", code: "3055", grade: "1B" },
  { id: "solo_nobeds", label: "機能強化型 単独型・病床なし", code: "3055", grade: "1N" },
  { id: "renkei_a_beds", label: "機能強化型 連携型（(2)ア）・病床あり", code: "4247", grade: "1B" },
  { id: "renkei_a_nobeds", label: "機能強化型 連携型（(2)ア）・病床なし", code: "4247", grade: "1N" },
  { id: "renkei_i", label: "連携型（(2)イ）", code: "3056", grade: "2" },
  { id: "zaishishin3", label: "在支診（(3)）", code: "3168", grade: "2" },
  { id: "outside", label: "在支診以外", code: null, grade: "3" },
] as const satisfies readonly { id: string; label: string; code: string | null; grade: FacilityGrade }[];

export type GradeChoice = (typeof GRADE_CHOICES)[number]["id"];

/** 種別から決まる施設基準コード（申告の一覧に出さず、`grade` の行で決める） */
export const GRADE_CODES: readonly string[] = [...new Set(GRADE_CHOICES.flatMap((g) => (g.code ? [g.code] : [])))];
