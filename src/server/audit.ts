// 監査ログ（spec FR-140）：誰が・どの操作を・どの対象 id に・結果・時刻。tenant の app.db の audit_log に置く。
// 本文（カルテ・回答・メンターへの発言）と氏名は入れない。入れるのは利用者 id・ロール・操作の名前・対象の id・結果だけ。
// ログイン・登録・招待・役割の切替は auth.db の auth_events にも残す（src/server/auth.ts の recordEvent）
import type Database from "better-sqlite3";

/** ok＝成功／denied＝権限なし／invalid＝入力がスキーマに合わない／limited＝回数制限／rejected＝業務上の拒否／error＝サーバー側の失敗 */
export type AuditResult = "ok" | "denied" | "invalid" | "limited" | "rejected" | "error";

export type AuditEntry = {
  userId: string;
  role: string;
  /** 操作の名前（権限表のキー。例 "POST /api/doctor/[id]/approve"） */
  action: string;
  /** 対象の id（質問の id・請求の id など。本文は入れない） */
  target?: string | null;
  result: AuditResult;
  status: number;
  /** デモの時計（画面の「今日」） */
  demoNow?: string | null;
};

export type AuditRow = { id: number; at: string; demoNow: string | null; userId: string; role: string; action: string; target: string | null; result: AuditResult; status: number };

/** 対象の id に長い文や改行が紛れ込まないように切る */
const cleanTarget = (t: string | null | undefined) => (t == null ? null : String(t).replace(/[\u0000-\u001f]/g, "").slice(0, 80));

export function createAudit(sqlite: Database.Database) {
  /** at は実時刻（デモの時計とは別に持つ） */
  function record(e: AuditEntry, at = new Date()) {
    sqlite
      .prepare("INSERT INTO audit_log (at, demo_now, user_id, role, action, target, result, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at.toISOString(), e.demoNow ?? null, e.userId, e.role, e.action, cleanTarget(e.target), e.result, e.status);
  }
  const list = (limit = 100) =>
    sqlite.prepare("SELECT id, at, demo_now AS demoNow, user_id AS userId, role, action, target, result, status FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as AuditRow[];
  return { record, list };
}

export type Audit = ReturnType<typeof createAudit>;
