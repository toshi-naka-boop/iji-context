// 表の作成と変更（マイグレーション）。どこまで適用したかは SQLite の PRAGMA user_version に持つ。
// 表を変えるときは、下の列の末尾に次の番号を足す。適用済みの番号の SQL は書き換えない
import type Database from "better-sqlite3";
import { CREATE_SQL } from "./schema";

export type Migration = { version: number; sql: string };

/** tenant の app.db（data/resemen.db も同じ） */
export const APP_MIGRATIONS: Migration[] = [
  {
    // ベースライン：この仕組みを入れる前から起動時に作っていた表。すでに表がある DB（user_version = 0）も通す
    version: 1,
    sql: `${CREATE_SQL}
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clerks (id TEXT PRIMARY KEY, name TEXT NOT NULL, call_name TEXT NOT NULL, character_id TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, clerk_id TEXT NOT NULL, claim_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chart_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, facts TEXT, clerk_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patient_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_key TEXT NOT NULL, fact_key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, valid_until TEXT, checked_at TEXT NOT NULL, checked_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS peer_questions (id TEXT PRIMARY KEY, from_clerk TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answered_by TEXT, knowledge_id TEXT, created_at TEXT NOT NULL, answered_at TEXT);
`,
  },
  {
    // 監査ログ（FR-140。本文・氏名は入れない）と、LLM・音声の 1 日の回数（FR-139。再起動で消えないよう DB に持つ）
    version: 2,
    sql: `
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, demo_now TEXT, user_id TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, status INTEGER NOT NULL);
CREATE TABLE rate_daily (day TEXT NOT NULL, bucket TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, bucket, user_id));
`,
  },
  {
    // 会議の整理で対象から外した、版のない提出の id の一覧（JSON 配列の文字列。design.md §4-4）
    version: 3,
    sql: `
ALTER TABLE reviews ADD COLUMN skipped TEXT NOT NULL DEFAULT '[]';
`,
  },
];

/** ログインの auth.db */
export const AUTH_MIGRATIONS: Migration[] = [
  {
    // ベースライン（上と同じ扱い）
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
`,
  },
  {
    // 利用者はクリニック（tenant）に属し、ロールを 1 つ持つ（FR-132）。それまでの利用者は 1 人 1 クリニックなので、
    // tenant_id は自分の id、ロールは今までの操作（算定）を続けられる事務にする。
    // 招待（FR-137。コードはハッシュだけ）と、ログインまわりの監査（FR-140）の表も足す
    version: 2,
    sql: `
ALTER TABLE users ADD COLUMN tenant_id TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'clerk';
UPDATE users SET tenant_id = id WHERE tenant_id IS NULL;
CREATE INDEX users_tenant ON users (tenant_id);
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);
CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, result TEXT NOT NULL, user_id TEXT, tenant_id TEXT, ip TEXT);
`,
  },
];

const versionOf = (sqlite: Database.Database) => sqlite.pragma("user_version", { simple: true }) as number;

/**
 * まだ適用していない番号を、1 つのトランザクションの中で順に適用する。適用後のバージョンを返す。
 * 途中で失敗したら全部を巻き戻し、バージョンも進めない。DB のほうが新しいとき（古いコードで開いたとき）は、知らない表を壊さないよう止める
 */
export function migrate(sqlite: Database.Database, migrations: Migration[]): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`マイグレーションの番号が連番でない: ${i + 1} 番目が ${m.version}`);
  });
  const current = versionOf(sqlite);
  if (current > migrations.length) throw new Error(`DB のバージョン ${current} がコードの ${migrations.length} より新しい。新しいコードで起動する`);
  if (current === migrations.length) return current;
  return sqlite
    .transaction(() => {
      // ほかのプロセスが先に適用していることがあるので、書き込みのロックを取ってから読み直す
      for (const m of migrations.slice(versionOf(sqlite))) {
        sqlite.exec(m.sql);
        sqlite.pragma(`user_version = ${m.version}`);
      }
      return versionOf(sqlite);
    })
    .immediate();
}
