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

export type Actor = "veteran" | "clerk" | "system";

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
};

/** 遷移の根拠（v15。round-10 の A・F・E） */
export type Basis = {
  /** 外れの結果で止めたとき、その提出（v19） */
  submissionIds?: string[];
  /** 外れた提出の、関係ありの区分 */
  kubun?: string[];
  /** トリガーによる遷移、または結果の遷移と同じ整理で同時に当たったトリガー */
  trigger?: TriggerKind;
  /** ベテランの回答による遷移のとき、その項目 id */
  itemId?: string;
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
  match: Match;
  history: HistoryEntry[];
};

export type TriggerKind = "revision" | "reappointment" | "idle";

export type LifecycleEvent =
  | { type: "VERIFY_APPROVE" }
  | { type: "VERIFY_REJECT"; reason: string }
  | { type: "EMPATHY" }
  | { type: "REEXAM_FILED" }
  | { type: "REEXAM_RESULT"; result: "原審どおり" | "復活" }
  | { type: "TRIGGER"; trigger: TriggerKind }
  | { type: "COUNTER_EXAMPLE" }
  | { type: "USED" }
  | { type: "RECHECK_PASS"; via: "claim" | "veteran" }
  | { type: "RECHECK_FAIL" }
  | { type: "IDLE_EXPIRED" }
  | { type: "DISPOSAL_APPROVE"; reason: string }
  | { type: "DISPOSAL_REJECT" };

/** 遷移に付随する副作用。書き込みは store が行う */
export type Effect =
  | { type: "DISPOSAL_PROPOSAL"; knowledgeId: string; cause: "IDLE_EXPIRED" | "COUNTER_EXAMPLE" | "RECHECK_FAIL" }
  | { type: "CREATE_REEXAM_ALLOWED"; sourceId: string };

export type TransitionResult = { meta: KnowledgeMeta; effects: Effect[] };
