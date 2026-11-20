// 表の作成と変更（src/db/migrate.ts）。DB はメモリの上に作る
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { APP_MIGRATIONS, AUTH_MIGRATIONS, migrate, type Migration } from "../../src/db/migrate";
import { CREATE_SQL } from "../../src/db/schema";

const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
/** 表の定義まで含めた中身（2 回目で何も変わらないことを見る） */
const schemaOf = (db: Database.Database) => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();

const APP_TABLES = ["app_settings", "applications", "audit_log", "chart_notes", "claim_facts", "claim_results", "clerk_sessions", "clerks", "digest_items", "patient_coverages", "patient_facts", "patients", "peer_questions", "questions", "rate_daily", "reviews", "submissions"];

describe("migrate", () => {
  it("空の DB に適用すると、バージョンが上がり表ができる", () => {
    const app = new Database(":memory:");
    expect(version(app)).toBe(0);
    expect(migrate(app, APP_MIGRATIONS)).toBe(APP_MIGRATIONS.length);
    expect(version(app)).toBe(APP_MIGRATIONS.length);
    expect(tables(app)).toEqual(APP_TABLES);

    // auth.db は別の列を持つ
    const auth = new Database(":memory:");
    expect(migrate(auth, AUTH_MIGRATIONS)).toBe(AUTH_MIGRATIONS.length);
    expect(tables(auth)).toEqual(["auth_events", "invites", "sessions", "users"]);
  });

  it("2 回呼んでも変わらない", () => {
    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('now', 'x')").run();
    const before = schemaOf(db);
    expect(migrate(db, APP_MIGRATIONS)).toBe(APP_MIGRATIONS.length);
    expect(schemaOf(db)).toEqual(before);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'now'").get()).toEqual({ value: "x" });
  });

  it("この仕組みの前に作った DB（表はあるがバージョン 0）でも通り、中身は残る", () => {
    const db = new Database(":memory:");
    db.exec(CREATE_SQL);
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('now', '2025-03-10T09:00:00+09:00')").run();
    db.prepare("INSERT INTO reviews (review_id, ran_at) VALUES ('r1', '2025-03-07T09:00:00+09:00')").run();
    expect(version(db)).toBe(0);
    expect(migrate(db, APP_MIGRATIONS)).toBe(APP_MIGRATIONS.length);
    expect(tables(db)).toEqual(APP_TABLES);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'now'").get()).toEqual({ value: "2025-03-10T09:00:00+09:00" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
  });

  it("途中で失敗したら、バージョンは進まず、先に通った番号も巻き戻る", () => {
    const db = new Database(":memory:");
    const ms: Migration[] = [
      { version: 1, sql: "CREATE TABLE a (id TEXT PRIMARY KEY);" },
      { version: 2, sql: "CREATE TABLE b (id TEXT PRIMARY KEY); INSERT INTO a (id) VALUES ('x');" },
      { version: 3, sql: "CREATE TABLE c (id TEXT PRIMARY KEY); INSERT INTO no_such_table VALUES (1);" },
    ];
    expect(() => migrate(db, ms)).toThrow(/no_such_table/);
    expect(version(db)).toBe(0);
    expect(tables(db)).toEqual([]);

    // 適用済みの番号がある DB でも、失敗した回の分だけが巻き戻る
    migrate(db, ms.slice(0, 1));
    expect(() => migrate(db, ms)).toThrow(/no_such_table/);
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual(["a"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM a").get()).toEqual({ n: 0 });
  });

  it("バージョン 2 を足したら、差分だけを適用する", () => {
    const db = new Database(":memory:");
    // 2 回適用すると失敗する SQL（IF NOT EXISTS なし）で、適用済みの番号を飛ばすことを見る
    const v1: Migration = { version: 1, sql: "CREATE TABLE a (id TEXT PRIMARY KEY); INSERT INTO a (id) VALUES ('first');" };
    const v2: Migration = { version: 2, sql: "ALTER TABLE a ADD COLUMN note TEXT;" };
    expect(migrate(db, [v1])).toBe(1);
    expect(migrate(db, [v1, v2])).toBe(2);
    expect(version(db)).toBe(2);
    expect(db.prepare("SELECT id, note FROM a").all()).toEqual([{ id: "first", note: null }]);
    expect(migrate(db, [v1, v2])).toBe(2);
  });

  it("DB のほうが新しいとき（古いコードで開いたとき）は、何も適用せずに止める", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 5");
    expect(() => migrate(db, [{ version: 1, sql: "CREATE TABLE a (id TEXT PRIMARY KEY);" }])).toThrow("より新しい");
    expect(version(db)).toBe(5);
    expect(tables(db)).toEqual([]);
  });

  it("バージョン 1 の auth.db を 2 へ上げると、既存の利用者に tenant_id（自分の id）とロール（事務）が入る", () => {
    const db = new Database(":memory:");
    migrate(db, AUTH_MIGRATIONS.slice(0, 1));
    expect(version(db)).toBe(1);
    db.prepare("INSERT INTO users (id, login, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run("t0123456789ab", "old_user", "まえから", "scrypt$x$x$x", "2026-11-01T00:00:00.000Z");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('h', 't0123456789ab', '2099-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')").run();
    expect(migrate(db, AUTH_MIGRATIONS)).toBe(AUTH_MIGRATIONS.length);
    expect(db.prepare("SELECT id, login, name, tenant_id, role FROM users").all()).toEqual([{ id: "t0123456789ab", login: "old_user", name: "まえから", tenant_id: "t0123456789ab", role: "clerk" }]);
    // セッションは残り、招待と監査の表ができる
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(tables(db)).toEqual(["auth_events", "invites", "sessions", "users"]);
  });

  it("バージョン 1 の app.db を 2 へ上げると、監査ログと 1 日の回数の表ができ、中身は残る", () => {
    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS.slice(0, 1));
    db.prepare("INSERT INTO clerks (id, name, call_name, character_id, role) VALUES ('new1', '新人', 'さん', 'a', 'clerk')").run();
    expect(migrate(db, APP_MIGRATIONS.slice(0, 2))).toBe(2);
    // 患者マスタの表は 4 番、請求ごとに確かめた事実の表は 6 番で足す
    expect(tables(db)).toEqual(APP_TABLES.filter((t) => t !== "patients" && t !== "patient_coverages" && t !== "claim_facts" && t !== "clerk_sessions"));
    expect(db.prepare("SELECT id FROM clerks").all()).toEqual([{ id: "new1" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
  });

  it("バージョン 3 の app.db を 4 へ上げると、確かめた患者情報の鍵が患者 id に変わり、それまでの番号は医保の加入情報として残る", () => {
    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS.slice(0, 3));
    const ins = db.prepare("INSERT INTO patient_facts (patient_key, fact_key, value, source, valid_until, checked_at, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run("39139999-00000004", "careLevel", "2", "介護保険証", "2025-05-31", "2025-03-10T09:00:00+09:00", "new1");
    ins.run("01139999-00000006", "table7", "true", "カルテ", null, "2025-03-11T09:00:00+09:00", "new1");
    ins.run("39139999-00000004", "homeOxygen", "false", "カルテ", null, "2025-03-12T09:00:00+09:00", "new1");
    expect(migrate(db, APP_MIGRATIONS.slice(0, 4))).toBe(4);
    expect(tables(db)).toEqual(APP_TABLES.filter((t) => t !== "claim_facts" && t !== "clerk_sessions"));
    // 同じ鍵の記録は同じ患者に寄り、ほかの列は変わらない
    expect(db.prepare("SELECT patient_id, fact_key, value, valid_until, checked_by FROM patient_facts ORDER BY id").all()).toEqual([
      { patient_id: "P0001", fact_key: "careLevel", value: "2", valid_until: "2025-05-31", checked_by: "new1" },
      { patient_id: "P0002", fact_key: "table7", value: "true", valid_until: null, checked_by: "new1" },
      { patient_id: "P0001", fact_key: "homeOxygen", value: "false", valid_until: null, checked_by: "new1" },
    ]);
    expect(db.prepare("SELECT id, name, birth, source FROM patients ORDER BY id").all()).toEqual([
      { id: "P0001", name: null, birth: null, source: "移行" },
      { id: "P0002", name: null, birth: null, source: "移行" },
    ]);
    expect(db.prepare("SELECT coverage_id, patient_id, kind, position, payer_number, member_no, source FROM patient_coverages ORDER BY id").all()).toEqual([
      { coverage_id: "C1", patient_id: "P0001", kind: "医保", position: 0, payer_number: "39139999", member_no: "00000004", source: "移行" },
      { coverage_id: "C2", patient_id: "P0002", kind: "医保", position: 0, payer_number: "01139999", member_no: "00000006", source: "移行" },
    ]);
    expect(tables(db)).not.toContain("patient_key_map");
  });

  it("番号が連番でなければ、何も適用せずに止める", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [{ version: 1, sql: "CREATE TABLE a (id TEXT);" }, { version: 3, sql: "CREATE TABLE b (id TEXT);" }])).toThrow("連番でない");
    expect(version(db)).toBe(0);
    expect(tables(db)).toEqual([]);
  });
});
