// 段 19a（design.md §16-8・16-7）：マイグレーション 17 と、構造化データを残す・読む（GET /api/chart/structured）。AI は呼ばない
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";
import { claimId, day, YM } from "../helpers/period";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), () => ({ structured: null })));

const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const schemaOf = (db: Database.Database) => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();

describe("マイグレーション 17（design.md §16-8）", () => {
  it("16 まで当てた DB に当たり、表が 2 つ増え、今の行は残る。もう一度当てても変わらない", () => {
    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS.slice(0, 16));
    expect(version(db)).toBe(16);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('now', 'x')").run();
    expect(APP_MIGRATIONS[16].version).toBe(17);
    expect(migrate(db, APP_MIGRATIONS.slice(0, 17))).toBe(17);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("chart_structured")).toEqual(["id", "patient_id", "year_month", "part", "status", "items", "gaps", "connector_id", "fetched_at"]);
    expect(cols("structured_inputs")).toEqual(["id", "patient_id", "date", "visit_ref", "start", "end", "entered_by", "entered_at"]);
    const before = schemaOf(db);
    expect(migrate(db, APP_MIGRATIONS.slice(0, 17))).toBe(17);
    expect(schemaOf(db)).toEqual(before);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'now'").get()).toEqual({ value: "x" });
  });
});

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-structured-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("structured_owner", "こうぞう", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

describe("GET /api/chart/structured（design.md §16-7）", () => {
  const get = (q: string, c: string | null = cookie) => new Request(`http://localhost/api/chart/structured?${q}`, { headers: c ? { cookie: c } : {} });
  const patientOf = (id: string) => instance.runAs(user, () => instance.getApp().structuredPatientOf(id));

  it("ログインが要り、診療年月の形を確かめる", async () => {
    const { GET } = await import("../../app/api/chart/structured/route");
    expect((await GET(get(`patientId=P0001&yearMonth=${YM}`, null))).status).toBe(401);
    expect((await GET(get("patientId=P0001&yearMonth=2026-1"))).status).toBe(400);
  });

  it("同梱の合成データの患者は、合成の接続先から読んで残す（structured/ のファイルがない患者は 4 種類とも unsupported）。患者の識別子は返さない", async () => {
    const { GET } = await import("../../app/api/chart/structured/route");
    const pid = patientOf(claimId("K1"));
    const res = await GET(get(`patientId=${pid}&yearMonth=${YM}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { parts: Record<string, { status: string; count: number | null }> };
    expect(Object.keys(body).sort()).toEqual(["connectorId", "fetchedAt", "parts", "source", "yearMonth"]);
    expect(body.connectorId).toBe("fixture");
    expect(body.source).toBe("電子カルテ");
    expect(Object.values(body.parts).map((p) => [p.status, p.count])).toEqual([["unsupported", null], ["unsupported", null], ["unsupported", null], ["unsupported", null]]);
    expect(JSON.stringify(body)).not.toContain(pid);
  });

  it("残した行の最新を種類ごとに返す（0 件と unsupported は別。欠けの数・出どころの印つき）", async () => {
    const { GET } = await import("../../app/api/chart/structured/route");
    const pid = patientOf(claimId("K2"));
    instance.runAs(user, () => {
      const a = instance.getApp();
      a.saveStructured(pid, YM, "fixture", { visits: { status: "supported", items: [], gaps: {} }, orders: { status: "unsupported" }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } });
      a.saveStructured(pid, YM, "fixture", {
        visits: { status: "supported", items: [{ ref: "v1", date: day(3), start: "09:00", end: null, kind: "訪問診療" }], gaps: { end: 1 } },
        orders: { status: "supported", items: [], gaps: {} },
        procedures: { status: "unsupported" },
        homeCare: { status: "unsupported" },
      });
    });
    const body = (await (await GET(get(`patientId=${pid}&yearMonth=${YM}`))).json()) as { parts: Record<string, { status: string; count: number | null; gaps?: Record<string, number> }> };
    expect(body.parts.visits).toMatchObject({ status: "supported", count: 1, gaps: { end: 1 } });
    expect(body.parts.orders).toMatchObject({ status: "supported", count: 0 });
    expect(body.parts.procedures).toEqual({ status: "unsupported", count: null });
  });
});
