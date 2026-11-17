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

const APP_TABLES = ["app_settings", "applications", "chart_notes", "claim_results", "clerks", "digest_items", "patient_facts", "peer_questions", "questions", "reviews", "submissions"];

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
    expect(tables(auth)).toEqual(["sessions", "users"]);
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

  it("番号が連番でなければ、何も適用せずに止める", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [{ version: 1, sql: "CREATE TABLE a (id TEXT);" }, { version: 3, sql: "CREATE TABLE b (id TEXT);" }])).toThrow("連番でない");
    expect(version(db)).toBe(0);
    expect(tables(db)).toEqual([]);
  });
});
