// 規則で出す算定のコード（design.md §16-4。EM §2-8 の別表「規則の候補で使うコード」。W-15）。版の codes には入れない。テストで EM の行と縛る（tests/structured/rule-codes.test.ts）。
// 設計パラメータ（config/structured.json）もここで読む
import { readFileSync } from "node:fs";
import path from "node:path";

export const RULE_CODES = {
  /** 調剤料 内服（R8-228） */
  chozaiOral: "120000710",
  /** 調剤料 外用（R8-229） */
  chozaiExternal: "120001010",
  /** 麻薬等加算 調剤料の側（R8-230） */
  mayakuChozai: "120000110",
  /** 処方料 その他（R8-231）。区分を決めない 1 件の、手順 1〜3 に入れるコード */
  shohoryo3: "120001210",
  /** 処方料 7 種類以上内服薬（R8-232）。同上 */
  shohoryo2: "120002610",
  /** 麻薬等加算 処方料の側（R8-233） */
  mayakuShohoryo: "120001310",
  /** 患家診療時間加算 訪問診療（R8-202） */
  kakaVisit: "114001470",
  /** 患家診療時間加算 往診（R8-203） */
  kakaOushin: "114000970",
  /** 患家診療時間加算 特別往診（R8-203。請求にあれば往診の時間の加算は「ある」とみなす。候補にはしない。L-179） */
  kakaOushinSpecial: "114002470",
  /** 在宅酸素療法材料加算 2（R8-215。酸素の機器と C103 の 2 から出す。機器ではない） */
  oxygenMaterial2: "114041610",
} as const;

/** 同じ患家の 2 人目以降の摘要欄の記載（EM §2-10。R8-207） */
export const SECOND_PATIENT_COMMENT = "820100847";

/** 設計パラメータ（config/structured.json）。rxLookbackMonths：注2 の確かめにさかのぼって読む月数（L-201） */
export type StructuredConfig = { rxLookbackMonths: number };
let cached: StructuredConfig | undefined;
export function structuredConfig(): StructuredConfig {
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), "config", "structured.json"), "utf8")) as StructuredConfig;
  return cached;
}
