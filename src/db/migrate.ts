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
  {
    // 患者マスタ（FR-121）：患者と、その保険・公費の加入情報（追記型。coverage_id ごとに最新の 1 行を使う）。
    // 確かめた患者情報（patient_facts）の鍵を「保険者番号-被保険者番号」から患者 id に寄せる。
    // それまでの鍵ごとに患者を 1 人作り（氏名・生年月日は空。次に UKE を読んだときに埋まる）、番号は医保の加入情報として残す
    version: 4,
    sql: `
CREATE TABLE patients (id TEXT PRIMARY KEY, name TEXT, sex INTEGER, birth TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE patient_coverages (id INTEGER PRIMARY KEY AUTOINCREMENT, coverage_id TEXT NOT NULL, patient_id TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL, payer_number TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '', member_no TEXT NOT NULL, burden_ratio REAL, valid_from TEXT, valid_until TEXT, source TEXT NOT NULL, checked_by TEXT, checked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX patient_coverages_patient ON patient_coverages (patient_id);
CREATE INDEX patient_coverages_number ON patient_coverages (payer_number, member_no);
CREATE TABLE patient_key_map (old_key TEXT PRIMARY KEY, patient_id TEXT NOT NULL, at TEXT NOT NULL);
INSERT INTO patient_key_map (old_key, patient_id, at)
  SELECT patient_key, 'P' || printf('%04d', ROW_NUMBER() OVER (ORDER BY MIN(id))), MIN(checked_at) FROM patient_facts GROUP BY patient_key;
INSERT INTO patients (id, source, updated_at) SELECT patient_id, '移行', at FROM patient_key_map;
INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, member_no, source, created_at)
  SELECT '', patient_id, '医保', 0, substr(old_key, 1, instr(old_key, '-') - 1), substr(old_key, instr(old_key, '-') + 1), '移行', at
  FROM patient_key_map WHERE instr(old_key, '-') > 1 ORDER BY patient_id;
UPDATE patient_coverages SET coverage_id = 'C' || id;
UPDATE patient_facts SET patient_key = (SELECT m.patient_id FROM patient_key_map m WHERE m.old_key = patient_facts.patient_key);
ALTER TABLE patient_facts RENAME COLUMN patient_key TO patient_id;
DROP TABLE patient_key_map;
`,
  },
  {
    // ベテランへの問いが、どの請求の相談から出たか（design.md §11-11「消す」：取り込んだファイルを消すとき、その請求の問いも消す）。それまでの問いは空
    version: 5,
    sql: `
ALTER TABLE peer_questions ADD COLUMN claim_id TEXT;
`,
  },
  {
    // 請求ごとに確かめた事実（その月・その日の出来事についての事実。患者ごとの patient_facts とは別。追記型で、項目と日付ごとに最新の 1 行を使う）。
    // date は日付ごとの事実だけが持ち、ほかは空文字
    version: 6,
    sql: `
CREATE TABLE claim_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, source TEXT NOT NULL, checked_by TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE INDEX claim_facts_claim ON claim_facts (claim_id);
`,
  },
  {
    // その人がこれまでに使った、メンターのセッション id の全部（design.md §11-11「消す」：過去のセッションの記録も消すため）。
    // clerks.session_id は「いま続けるセッション」1 つだけで、世代が変わる・作り直すと前の id を失う。いま入っている id は写す
    version: 7,
    sql: `
CREATE TABLE clerk_sessions (clerk_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (clerk_id, session_id));
INSERT INTO clerk_sessions (clerk_id, session_id) SELECT id, session_id FROM clerks WHERE session_id IS NOT NULL AND session_id != '';
`,
  },
  {
    // 医師に確かめてほしい項目に、医師が「その他」「判定不能」と答えた記録（事実は不明のまま。その他の自由記述は free_text）。
    // 追記型で、請求・項目・日付ごとに最新の 1 行を使う。date は日付ごとの事実だけが持ち、ほかは空文字
    version: 8,
    sql: `
CREATE TABLE doctor_fact_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', option TEXT NOT NULL, free_text TEXT, answered_by TEXT NOT NULL, answered_at TEXT NOT NULL);
CREATE INDEX doctor_fact_notes_claim ON doctor_fact_notes (claim_id);
`,
  },
  {
    // 算定プレビューで医療事務が入れた摘要欄の記載（design.md §11-13。導出が needsInput とした記載）。確定したカルテ（請求とその日）ごと。
    // slot は導出の記載の場所（記載の表の行・導出が決めたコード・同じ行とコードの何件目）で、同じ slot は入れ直すと置き換える。
    // text は自由記載で氏名が入り得るので、ログ・監査ログ・AI に送る文脈には出さない
    version: 9,
    sql: `
CREATE TABLE chart_comments (note_id INTEGER NOT NULL, claim_id TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, code TEXT NOT NULL, text TEXT NOT NULL, clerk_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (note_id, slot));
CREATE INDEX chart_comments_claim ON chart_comments (claim_id);
`,
  },
  {
    // 背反の組の院内の知識に USED を出した記録（design.md §14-3。C-172・X-121）：同じ請求・同じ知識は 1 日（日本時間）1 回まで。行があれば、その日はもう出さない
    version: 10,
    sql: `
CREATE TABLE local_used (claim_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (claim_id, knowledge_id, day));
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
  {
    // 注意書きへの同意（design.md §11-11）：利用者ごとに、同意した注意書きの版と時刻。それまでの利用者は空（次の操作で聞かれる）
    version: 3,
    sql: `
ALTER TABLE users ADD COLUMN accepted_notice_version TEXT;
ALTER TABLE users ADD COLUMN accepted_notice_at TEXT;
`,
  },
  {
    // サーバー全体の 1 日の回数（spec U-W。2026-11-21 利用者の判断）：LLM・音声の呼び出しを、全部のクリニック・全部の利用者で数える。
    // 利用者ごとの数は tenant の app.db の rate_daily にあり、ここには全体の数だけを置く（user_id は '*'）
    version: 4,
    sql: `
CREATE TABLE rate_daily (day TEXT NOT NULL, bucket TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, bucket, user_id));
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
