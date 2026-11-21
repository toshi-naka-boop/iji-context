// 公的文書（疑義解釈・審査の一般的な取扱い・審査情報提供事例）の型（design.md §4-6。FR-124）
// 持つのは自前の要旨とリンクだけで、原文は転載しない（FR-125）
import type { Match } from "../lifecycle/types";

export type OfficialKind = "疑義解釈" | "審査の一般的な取扱い" | "審査情報提供事例";
export type Stance = "認める" | "認めない" | "条件つき";

export type OfficialDoc = {
  /** evidence-master §2-4「採用した公的文書」の id */
  id: string;
  kind: OfficialKind;
  issuer: string;
  number: string;
  /** 発出日（公表日）YYYY-MM-DD */
  issuedOn: string;
  url: string;
  scope: {
    /** 対象区分（点数表にあるキー。1 つ以上） */
    kubun: string[];
    /** null＝審査支払機関を問わない（厚労省の疑義解釈など） */
    payer: "支払基金" | "国保連" | null;
    /** null＝全国 */
    prefecture: string | null;
    facts?: Match["facts"];
    commentOn?: Match["commentOn"];
    consecutiveMonths?: Match["consecutiveMonths"];
    /** 上の語彙で表せない条件（傷病名が疑いか確定か、など） */
    conditionNote: string | null;
  };
  stance: Stance;
  /** 自前の要旨（200 字まで。点数・金額を含めない） */
  summary: string;
  /** 確認日 YYYY-MM-DD */
  checkedOn: string;
  /** 適用する改定（Revision.generation） */
  generations: string[];
};

/** ローカルルール 1 件についての突き合わせの結果（FR-128） */
export type Verdict = "整合" | "矛盾の恐れ" | "公的根拠なし" | "関連あり・未照合";

/** トリガー④と議題に渡すもの。lifecycle はエンジンを import しないので、版の世代とルールの区分は関数で受け取る */
export type OfficialInput = {
  docs: OfficialDoc[];
  /** 年月（YYYY-MM）の版の generation。その年月の版がなければ null（④ は判定しない） */
  generationOf: (yearMonth: string) => string | null;
  /** ruleId を持つ知識の区分（その年月の版のルールの kubun）。渡されなければ、ruleId だけの知識は区分なしとして扱う */
  ruleKubun?: (ruleId: string, yearMonth: string) => string[];
};
