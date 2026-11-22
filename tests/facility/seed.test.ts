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
const { demoDeclaration: _seed, recheckNoticeDays: _days, ...CONFIG } = facilityConfig;
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
    const e = effectiveRow(rows, s.itemKey, { yearMonth: YM });
    expect([s.itemKey, e?.row.source, e?.row.choice, e?.row.notified, e?.row.requirement, e?.row.startOn]).toEqual([s.itemKey, "seed", s.choice, s.notified, s.requirement, s.startOn]);
  }
  return rows.length;
}

/** K1〜K7 の施設の設定と判定（合計・指摘）が、v28（config の既定値と症例ごとの上書き）と同じ */
function sameAsV28(app: ReturnType<typeof openApp>) {
  for (const k of CASES) {
    const ctx = app.caseOf(claimId(k));
    const fixture = JSON.parse(readFileSync(path.join(repo, "fixtures", "cases", `${k}.json`), "utf8")) as { facility?: Partial<FacilityJson> };
    const v28 = facilityOf(CONFIG as unknown as FacilityJson, fixture.facility);
    expect([k, ctx.facility]).toEqual([k, v28]);
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
    db.prepare("INSERT INTO facility_declarations (item_key, notified, requirement, choice, checked_by, checked_role, checked_on, recheck_on, source, created_at) VALUES ('note16', 'na', 'not_met', NULL, 'a', 'manager', '2026-10-13', '2027-01-13', 'input', 't')").run();
    db.prepare("INSERT INTO facility_declarations (item_key, notified, requirement, choice, checked_by, checked_role, source, created_at) VALUES ('dispensing', 'na', 'met', 'outside', 'system', 'system', 'migrated', 't')").run();
    expect(becomeDemo(db, "t")).toBe(1);
    const rows = readDeclarations(db);
    expect(effectiveRow(rows, "note16", { yearMonth: YM })?.row.source).toBe("input");
    expect(effectiveRow(rows, "dispensing", { yearMonth: YM })?.row.source).toBe("seed");
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
    expect(facilityFromDeclaration(rows, "2026-12-01", YM)).toEqual({ grade: null, note16Met: null, dxTier: null, baseUp: null });
    db.close();
  });

  it("src/ の中で、クリニックの種類を demo にする SQL を直書きしていない。種の行を足すのは src/facility/seed.ts だけ", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : /\.tsx?$/.test(f) ? [path.join(dir, f)] : []));
    const src = files(path.join(repo, "src"));
    const demoKind = /tenants[^;`"]*kind\s*=\s*'demo'|INSERT INTO tenants[^;`"]*'demo'/;
    expect(src.filter((f) => demoKind.test(readFileSync(f, "utf8"))).map((f) => path.relative(repo, f))).toEqual([]);
    const seeds = src.filter((f) => /source:\s*"seed"|'seed'\)/.test(readFileSync(f, "utf8"))).map((f) => path.relative(repo, f));
    expect(seeds).toEqual([path.join("src", "facility", "seed.ts")]);
  });
});
