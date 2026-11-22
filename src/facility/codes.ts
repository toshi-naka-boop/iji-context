// 施設基準コードの読み方の例外と、施設の種別（design.md §15-2・§15-3。EM §2-11 表 4・R8-48）。
// どのコードも config/shisetsu-kijun.json（表 4 の写し）にあることを tests/facility/shisetsu-kijun.test.ts が縛る
import type { FacilityGrade } from "../engine/types";

/** 在宅療養支援病院のコード。診療所は持たない（J-2）。申告によらず「持たない」 */
export const HOSPITAL_CODES = ["3057", "3058", "3169"] as const;

/** EM §2-11 表 4 の 1 行に診療所と並ぶ、病院の側のコード（在宅医療充実体制加算・在宅療養実績加算1・2 の病院）。診療所は持たない。申告によらず「持たない」 */
export const HOSPITAL_SIDE_CODES = ["4249", "3341", "3474"] as const;

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

/** 名寄せのコード（8032）が表す施設基準コード（EM §2-11 表 4。［基］p172）。G10 は 4 つに開いてから組の「どれか」を見る（design.md §15-3） */
export const NAYOSE: Readonly<Record<string, readonly string[]>> = { "8032": ["3055", "4247", "3056", "3168"] };

/** 注14 の基準のコード（減算の行に付く。「届出があれば算定できる」と読まない）。G10 は、このコードを含む組の行を判定しない（design.md §15-3） */
export const NOTE14_CODE = "4101";

/**
 * 施設基準コード → 担当する手書きのルールと申告の値（design.md §15-5「手書きのルールと 2 回言わない」。C-216）。
 * 担当のルールがその行について申告の値で言ったとき（keys の指摘か、fields の情報不足）、G10 はそのコードについて言わない。表にないコードは G10 だけが言う
 */
export const KIJUN_OWNERS: readonly { codes: readonly string[]; rule: string; keys: readonly string[]; fields: readonly string[] }[] = [
  { codes: ["3055", "4247", "3056", "3168", "8032"], rule: "R18", keys: ["R18.use_grade", "R18.iko_grade3_only", "R18.use_baseup_note5", "R18.use_baseup_normal"], fields: ["facility.grade"] },
  { codes: ["4307", "4303"], rule: "R18", keys: ["R18.use_grade", "R18.iko_grade3_only", "R18.use_baseup_note5", "R18.use_baseup_normal"], fields: ["facility.baseUp"] },
  { codes: ["4100"], rule: "R12", keys: ["R12.dx_not_notified", "R12.dx_tier"], fields: ["facility.dxTier"] },
];
