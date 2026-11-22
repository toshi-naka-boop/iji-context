// 施設の申告の種と、v28 の設定の移し替え（src/facility/seed.ts・マイグレーション 12。design.md §15-2・§15-10 の段 17b。C-214・C-222）。
// 種が入る 4 つの経路（クリニックを作る・reset-demo・マイグレーション 12・未定からデモを選ぶ）のどれでも、種の全項目が効く行になり、K1〜K7 の判定が v28 と同じ
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import facilityConfig from "../../config/facility.json";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { evaluate } from "../../src/engine";
import { facilityOf, type FacilityJson } from "../../src/engine/facility";
import { effectiveRow, facilityFromDeclaration } from "../../src/facility/declaration";
import { APPLIED_KEY, becomeDemo, demoSeedRows, readDeclarations } from "../../src/facility/seed";
import { openApp, type AppPaths } from "../../src/server/app";
import { claimId, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
const { demoDeclaration: _seed, recheckNoticeDays: _days, recheckDefaultMonths: _months, ...CONFIG } = facilityConfig;
const CASES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];

let tmp: string;
let instance: typeof import("../../src/server/instance");
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-facility-seed-"));
  process.env.RESEMEN_DATA = path.join(tmp, "data");
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

let n = 0;
const pathsOf = (dir = path.join(tmp, `app${n++}`)): AppPaths => (mkdirSync(dir, { recursive: true }), { root: repo, dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: path.join(dir, "query-log") });
const dbOf = (file: string) => new Database(file);

/** 種の全項目が、基準月の効く行になっているか（中身が種と同じ） */
function seedIsEffective(file: string) {
  const db = dbOf(file);
  const rows = readDeclarations(db);
  db.close();
  for (const s of demoSeedRows()) {
    const e = effectiveRow(rows, s.itemKey, YM);
    expect([s.itemKey, e?.row.source, e?.row.fromMonth, e?.row.choice, e?.row.notified, e?.row.requirement, e?.row.startOn]).toEqual([s.itemKey, "seed", s.fromMonth, s.choice, s.notified, s.requirement, s.startOn]);
  }
  return rows.length;
}

/** K1〜K7 の施設の設定と判定（合計・指摘）が、v28（config の既定値と症例ごとの上書き）と同じ */
function sameAsV28(app: ReturnType<typeof openApp>) {
  for (const k of CASES) {
    const ctx = app.caseOf(claimId(k));
    const fixture = JSON.parse(readFileSync(path.join(repo, "fixtures", "cases", `${k}.json`), "utf8")) as { facility?: Partial<FacilityJson> };
    const v28 = facilityOf(CONFIG as unknown as FacilityJson, fixture.facility);
    // 申告から来る種別の選択肢（R18 の断りに使う。段 17d）のほかは v28 と同じ
    const { gradeChoice, ...facility } = ctx.facility;
    expect([k, gradeChoice, facility]).toEqual([k, "zaishishin3", v28]);
    const now = evaluate(ctx);
    const before = evaluate({ ...ctx, facility: v28 });
    expect([k, now.total, now.findings]).toEqual([k, before.total, before.findings]);
  }
}

describe("種が入る 4 つの経路", () => {
  it("クリニックを作るとき（demo）：初めて開いたときのマイグレーション 12 で種が入り、K1〜K7 が v28 と同じ", () => {
    const u = instance.getAuth().register("seed_create", "つくる", "password123", "demo");
    const app = instance.runAs(u, () => instance.getApp());
    expect(seedIsEffective(instance.tenantPaths(u.tenantId).dbFile)).toBe(demoSeedRows().length);
    sameAsV28(app);
  });

  it("reset-demo：置き場を消して開き直すと、種が入り直す", () => {
    const p = pathsOf();
    openApp(p, { kind: "demo" }).close();
    rmSync(path.dirname(p.dbFile), { recursive: true, force: true });
    mkdirSync(path.dirname(p.dbFile), { recursive: true });
    const app = openApp(p, { kind: "demo" });
    expect(seedIsEffective(p.dbFile)).toBe(demoSeedRows().length);
    sameAsV28(app);
    app.close();
  });

  it("マイグレーション 12：申告の行のない既存のデモ用クリニック（バージョン 11）に種が入り、reset-demo なしで K1〜K7 が v28 と同じ", () => {
    const p = pathsOf();
    mkdirSync(path.dirname(p.dbFile), { recursive: true });
    const old = dbOf(p.dbFile);
    migrate(old, APP_MIGRATIONS.slice(0, 11));
    old.close();
    const app = openApp(p, { kind: "demo" });
    expect(seedIsEffective(p.dbFile)).toBe(demoSeedRows().length);
    sameAsV28(app);
    app.close();
  });

  it("未定 → デモを選ぶ：未定の間は申告がなく種別が分からず、app_settings は残る。選んで開き直すと種が入る", () => {
    const owner = instance.getAuth().register("seed_choose", "えらぶ", "password123", "demo");
    // 種類を持つ前のクリニックにする（行がないクリニックは未定）
    const auth = dbOf(path.join(tmp, "data", "auth.db"));
    auth.prepare("DELETE FROM tenants WHERE id = ?").run(owner.tenantId);
    auth.close();
    const file = instance.tenantPaths(owner.tenantId).dbFile;
    mkdirSync(path.dirname(file), { recursive: true });
    const pre = dbOf(file);
    migrate(pre, APP_MIGRATIONS.slice(0, 11));
    pre.prepare("INSERT INTO app_settings (key, value) VALUES ('facility', ?)").run(JSON.stringify({ note16Met: false, dxTier: "なし" }));
    pre.close();
    const und = instance.runAs(owner, () => instance.getApp());
    expect(und.kind).toBe("undecided");
    let db = dbOf(file);
    expect(readDeclarations(db)).toEqual([]);
    expect(facilityFromDeclaration(readDeclarations(db), "2026-12-01", YM).grade).toBeNull();
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'facility'").get()).toEqual({ value: JSON.stringify({ note16Met: false, dxTier: "なし" }) });
    db.close();

    instance.getAuth().chooseKind({ ...owner, role: "manager" }, "demo");
    instance.reopenTenant(owner.tenantId);
    const app = instance.runAs(owner, () => instance.getApp());
    expect(app.kind).toBe("demo");
    expect(seedIsEffective(file)).toBe(demoSeedRows().length);
    sameAsV28(app);
    db = dbOf(file);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APPLIED_KEY)).toEqual({ value: "demo" });
    db.close();
  });
});

describe("種と移し替えの決まり", () => {
  it("2 回呼んでも行が増えない。利用者が残した行（input）は上書きしない。migrated の行は種で上書きする", () => {
    const p = pathsOf();
    openApp(p, { kind: "demo" }).close();
    const db = dbOf(p.dbFile);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM facility_declarations").get() as { n: number }).n;
    const first = count();
    expect(becomeDemo(db, "t")).toBe(0);
    expect(becomeDemo(db, "t")).toBe(0);
    expect(count()).toBe(first);
    // 利用者が残した行が 1 つでもある項目には足さない（その行の from_month が種より後でも）
    db.prepare("INSERT INTO facility_declarations (item_key, from_month, notified, requirement, choice, checked_by, checked_role, checked_on, recheck_on, source, created_at) VALUES ('note16', ?, 'na', 'not_met', NULL, 'a', 'manager', '2026-10-13', '2027-01-13', 'input', 't')").run(YM);
    db.prepare("INSERT INTO facility_declarations (item_key, notified, requirement, choice, checked_by, checked_role, source, created_at) VALUES ('dispensing', 'na', 'met', 'outside', 'system', 'system', 'migrated', 't')").run();
    expect(becomeDemo(db, "t")).toBe(0);
    // 同じ from_month の最新の行が種でなくなった項目（migrated で上書きした）には、種を足し直す
    db.prepare("INSERT INTO facility_declarations (item_key, from_month, notified, requirement, choice, checked_by, checked_role, source, created_at) VALUES ('dispensing', ?, 'na', 'met', 'outside', 'system', 'system', 'migrated', 't')").run(demoSeedRows()[0].fromMonth);
    expect(becomeDemo(db, "t")).toBe(1);
    const rows = readDeclarations(db);
    expect(effectiveRow(rows, "note16", YM)?.row.source).toBe("input");
    expect(effectiveRow(rows, "dispensing", YM)?.row.source).toBe("seed");
    db.close();
    // 開き直しても増えない
    const before = readDeclarations(dbOf(p.dbFile)).length;
    openApp(p, { kind: "demo" }).close();
    expect(readDeclarations(dbOf(p.dbFile)).length).toBe(before);
  });

  it("未定 → 実在用を選ぶと、v28 の note16Met・dxTier・baseUp が申告に移り（確かめた日がないので分からない）、移したキーは app_settings から外れる", () => {
    const p = pathsOf();
    mkdirSync(path.dirname(p.dbFile), { recursive: true });
    const pre = dbOf(p.dbFile);
    migrate(pre, APP_MIGRATIONS.slice(0, 11));
    pre.prepare("INSERT INTO app_settings (key, value) VALUES ('facility', ?)").run(JSON.stringify({ note16Met: false, dxTier: "2", baseUp: "注5", priceResponse: false }));
    pre.close();
    openApp(p, { kind: "undecided" }).close();
    expect(readDeclarations(dbOf(p.dbFile))).toEqual([]);
    openApp(p, { kind: "real" }).close();
    const db = dbOf(p.dbFile);
    const rows = readDeclarations(db);
    expect(rows.map((r) => [r.itemKey, r.notified, r.requirement, r.choice, r.source, r.checkedOn, r.recheckOn])).toEqual([
      ["note16", "na", "not_met", null, "migrated", null, null],
      ["code:4100", "yes", "met", "2", "migrated", null, null],
      ["code:4307", "yes", "met", null, "migrated", null, null],
      ["code:4303", "yes", "met", null, "migrated", null, null],
    ]);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'facility'").get()).toEqual({ value: JSON.stringify({ priceResponse: false }) });
    // 移した行は from_month が空なので効く行に選ばれない（推し量って埋めない）
    expect(rows.every((r) => r.fromMonth === null)).toBe(true);
    expect(facilityFromDeclaration(rows, "2026-12-01", YM)).toEqual({ grade: null, gradeChoice: null, note16Met: null, dxTier: null, baseUp: null, zaishishin: null, kyokagata: null, hasBeds: null });
    db.close();
  });

  it("kind を auth.db に書いたあと applyKind の前で止めた状態から開き直すと、種（demo）か移し替え（real）が入り、印が kind と同じ。2 回開いても行が増えない", () => {
    for (const kind of ["demo", "real"] as const) {
      const p = pathsOf();
      // 未定で開いた app.db（印なし・申告なし）に、kind だけが auth.db に書かれた状態
      openApp(p, { kind: "undecided" }).close();
      let db = dbOf(p.dbFile);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('facility', ?)").run(JSON.stringify({ note16Met: true }));
      expect(db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APPLIED_KEY)).toBeUndefined();
      db.close();
      openApp(p, { kind }).close();
      db = dbOf(p.dbFile);
      const n = readDeclarations(db).length;
      expect([kind, (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(APPLIED_KEY) as { value: string }).value]).toEqual([kind, kind]);
      expect([kind, readDeclarations(db).map((r) => r.source)[0]]).toEqual([kind, kind === "demo" ? "seed" : "migrated"]);
      db.close();
      openApp(p, { kind }).close();
      openApp(p, { kind }).close();
      expect([kind, readDeclarations(dbOf(p.dbFile)).length]).toEqual([kind, n]);
    }
  });

  it("マイグレーション 13：from_month のない種の行（12 で入れた）は、種の from_month で追記して直り K1〜K7 が v28 と同じ。input・migrated の行は空のまま残る", () => {
    const p = pathsOf();
    mkdirSync(path.dirname(p.dbFile), { recursive: true });
    const old = dbOf(p.dbFile);
    migrate(old, APP_MIGRATIONS.slice(0, 12));
    // v29（段 17b）の種：from_month の列がなく、算定開始年月日は前月の初日
    for (const s of demoSeedRows()) {
      old.prepare("INSERT INTO facility_declarations (item_key, notified, notified_on, start_on, requirement, choice, checked_by, checked_role, checked_on, recheck_on, source, created_at) VALUES (?, ?, NULL, ?, ?, ?, 'system', 'system', ?, ?, 'seed', 't')").run(s.itemKey, s.notified, s.startOn ? "2026-09-01" : null, s.requirement, s.choice, s.checkedOn, s.recheckOn);
    }
    old.prepare("INSERT INTO facility_declarations (item_key, notified, requirement, choice, checked_by, checked_role, checked_on, recheck_on, source, created_at) VALUES ('code:9999', 'yes', 'met', NULL, 'a', 'manager', '2026-10-01', '2027-10-01', 'input', 't')").run();
    old.prepare("INSERT INTO app_settings (key, value) VALUES (?, 'demo')").run(APPLIED_KEY);
    old.close();
    const app = openApp(p, { kind: "demo" });
    expect(seedIsEffective(p.dbFile)).toBe(demoSeedRows().length * 2 + 1);
    sameAsV28(app);
    app.close();
    const rows = readDeclarations(dbOf(p.dbFile));
    expect(rows.filter((r) => r.source === "input").map((r) => r.fromMonth)).toEqual([null]);
  });

  it("src/ の中で、クリニックの種類を demo にする SQL を直書きしていない。種の行を足すのは src/facility/seed.ts の becomeDemo だけ", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : /\.tsx?$/.test(f) ? [path.join(dir, f)] : []));
    const src = files(path.join(repo, "src"));
    const demoKind = /tenants[^;`"]*kind\s*=\s*'demo'|INSERT INTO tenants[^;`"]*'demo'/;
    expect(src.filter((f) => demoKind.test(readFileSync(f, "utf8"))).map((f) => path.relative(repo, f))).toEqual([]);
    const seeds = src.filter((f) => /source:\s*"seed"|'seed'\)/.test(readFileSync(f, "utf8"))).map((f) => path.relative(repo, f));
    expect(seeds).toEqual([path.join("src", "facility", "seed.ts")]);
    // seed.ts の中でも、種の中身（source: "seed"）を作るのは demoSeedRows だけで、それを呼ぶのは becomeDemo だけ
    const seedTs = readFileSync(path.join(repo, "src", "facility", "seed.ts"), "utf8");
    const fnOf = (i: number) => [...seedTs.slice(0, i).matchAll(/export function (\w+)/g)].at(-1)?.[1];
    expect([...seedTs.matchAll(/source:\s*"seed"/g)].map((m) => fnOf(m.index))).toEqual(["demoSeedRows"]);
    expect([...seedTs.matchAll(/(?<!function )demoSeedRows\(\)/g)].map((m) => fnOf(m.index))).toEqual(["becomeDemo"]);
  });
});
