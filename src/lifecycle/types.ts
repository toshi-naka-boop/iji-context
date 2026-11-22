// 知識ライフサイクルの型（design.md §3・§4）

export type Layer = "制度" | "地域" | "ベテラン" | "院内";

/** FR-64 の 6 状態で閉じる */
export type KnowledgeStatus = "未検証" | "承認済み" | "contested" | "要再検証" | "停止" | "保管";

export const ALL_STATUSES: readonly KnowledgeStatus[] = [
  "未検証",
  "承認済み",
  "contested",
  "要再検証",
  "停止",
  "保管",
];

export type SourceType =
  | "初期投入"
  | "返戻"
  | "査定"
  | "再審査"
  | "エスカレーション"
  | "提案"
  | "手動";

export type Polarity = "avoid" | "allow";

export type Actor = "veteran" | "clerk" | "manager" | "doctor" | "system";

/** 公的文書の条件に当たるかを、人が確かめた記録（design.md §11-3）。by は確かめた人の医療事務 id */
export type OfficialCheck = { applies: boolean; by: string; at: string };

export type Match = {
  /** 制度層：エンジンの applied に含まれれば適用 */
  ruleId?: string;
  /** 地域・ベテラン・院内：これらの区分がすべて lines にある */
  kubunAll?: string[];
  payer?: "支払基金" | "国保連";
  prefecture?: string;
  facts?: Partial<{ careLevelMin: number; insurance: string; table8_2: boolean; table7: boolean }>;
  /** その区分に摘要コメントが付いている（present=true）／付いていない（false）。v6 */
  commentOn?: { kubun: string; present: boolean }[];
  /** 当月を含め、その区分を何か月続けて算定しているか（history から数える）。v6 */
  consecutiveMonths?: { kubun: string; min: number };
  /**
   * 背反の 2 つのコード（小さい順）と表（tani 1＝1 日・2＝同一月・3＝同時。1 週間の表は対象にしない）。院内層とベテラン層（会議の修正版）だけが持つ。
   * これを持つ知識は、ほかのキーを持たない（store が検査）。条件は conditionNote の文だけで、機械では当てない（design.md §14-1）
   */
  codePair?: CodePair;
};

/** 背反の組（design.md §14-1） */
export type CodePair = { a: string; b: string; tani: 1 | 2 | 3 };

/** 遷移の根拠（v15。round-10 の A・F・E） */
export type Basis = {
  /** 外れの結果で止めたとき、その提出（v19） */
  submissionIds?: string[];
  /** 外れた提出の、関係ありの区分 */
  kubun?: string[];
  /** トリガーによる遷移、または結果の遷移と同じ整理で同時に当たったトリガー */
  trigger?: TriggerKind;
  /** トリガー④のとき、未確認だった矛盾の恐れの文書の鍵。回答で承認済みに戻したとき・種の直後は、確認済みに足した鍵（v22）。OFFICIAL_CHECK では確かめた文書の鍵 */
  officialIds?: string[];
  /** ベテランの回答による遷移のとき、その項目 id */
  itemId?: string;
  /** localReturn のとき、返戻・査定された請求の id（design.md §14-4） */
  claimId?: string;
  /** localRevision・localReturn のとき、その組 */
  codePair?: CodePair;
  /** localRevision のとき、改定の前後で差が出た項目（design.md §14-4） */
  changes?: string[];
  /** localRevision のとき、どの改定日の棚卸か（結果を残す前に止まったときに、history から結果を戻す。round-45 codex #2） */
  revisionDate?: string;
};

export type HistoryEntry = {
  at: string;
  from: string;
  to: string;
  event: string;
  actor: Actor;
  basis: Basis | null;
};

export type KnowledgeMeta = {
  /** "<layerSlug>/<slug>" */
  id: string;
  layer: Layer;
  status: KnowledgeStatus;
  summary: string;
  /** SKILL.md 本文・match・polarity・matchApprox・conditionNote の内容ハッシュ先頭 12 桁 */
  rev: string;
  polarity: Polarity;
  matchApprox: boolean;
  conditionNote: string | null;
  source_event: { type: SourceType; ref: string; at: string };
  relates_to: string | null;
  valid_from: string;
  review_by: string | null;
  hits: number;
  misses: number;
  /** max(last_used_at, 今有効な当たりの結果の取り込み日)。store が数え直す */
  last_hit_at: string | null;
  /** USED を受けた最後の日（v7） */
  last_used_at: string | null;
  /** 現在の状態に入った日 */
  status_since: string;
  retired_reason: string | null;
  empathy: number;
  /**
   * 背反の組の知識（match.codePair）の、改定の棚卸の記録（改定日 → pending＝改定後の 1 枚がまだなく保留／same＝差がなかった／changed＝差が出た・比べられないので要再検証にした）。
   * 知識の状態や status_since とは別に持つので、別の理由で承認し直しても保留は消えない（design.md §14-4。round-43 codex #2）。rev のハッシュに入れない
   */
  revision_checks?: Record<string, "pending" | "same" | "changed">;
  /** 会議で確認済みの公的文書の鍵（昇順。既定は空。rev のハッシュに入れない。design.md §4-3） */
  official_seen: string[];
  /**
   * 公的文書の条件に当たるかを人が確かめた記録（鍵は文書の鍵 <id>#<h>。なければ未確認。rev のハッシュに入れない。design.md §11-3）。
   * applies＝この知識が当たる請求の中に、その文書の条件の請求がある。知識の conditionNote は判断に入れない
   */
  official_checks?: Record<string, OfficialCheck>;
  match: Match;
  history: HistoryEntry[];
};

/** localRevision・localReturn は、codePair を持つ知識だけに効く（design.md §14-4） */
export type TriggerKind = "revision" | "reappointment" | "idle" | "official" | "localRevision" | "localReturn";

export type LifecycleEvent =
  | { type: "VERIFY_APPROVE" }
  | { type: "VERIFY_REJECT"; reason: string }
  | { type: "EMPATHY" }
  | { type: "REEXAM_FILED" }
  | { type: "REEXAM_RESULT"; result: "原審どおり" | "復活" }
  | { type: "TRIGGER"; trigger: TriggerKind }
  | { type: "COUNTER_EXAMPLE" }
  | { type: "USED" }
  /** 種の時点で矛盾している公的文書を、確認済みとして記録する（状態は変えない。design.md §4-3） */
  | { type: "OFFICIAL_BASELINE"; officialKeys: string[] }
  /** 公的文書の条件に当たるかを人が確かめた（状態は変えない。design.md §11-3）。actor は確かめた人の役割 */
  | { type: "OFFICIAL_CHECK"; key: string; applies: boolean; by: string; actor: Exclude<Actor, "system"> }
  /** officialKeys：議題の項目に載っていた公的文書の鍵（確認済みに足す） */
  | { type: "RECHECK_PASS"; via: "claim" | "veteran"; officialKeys?: string[] }
  | { type: "RECHECK_FAIL" }
  | { type: "IDLE_EXPIRED" }
  | { type: "DISPOSAL_APPROVE"; reason: string }
  | { type: "DISPOSAL_REJECT"; officialKeys?: string[] };

/** 遷移に付随する副作用。書き込みは store が行う */
export type Effect =
  | { type: "DISPOSAL_PROPOSAL"; knowledgeId: string; cause: "IDLE_EXPIRED" | "COUNTER_EXAMPLE" | "RECHECK_FAIL" }
  | { type: "CREATE_REEXAM_ALLOWED"; sourceId: string };

export type TransitionResult = { meta: KnowledgeMeta; effects: Effect[] };
