// 共通ルートヘルパ（src/server/http.ts の route）：入力の検証・エラーの扱い・回数制限・監査ログ（spec FR-135・FR-136・FR-139・FR-140）
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { openAuth, type User } from "../../src/server/auth";
import { UserError } from "../../src/server/errors";
import type { Allowed } from "../../src/server/policy";
import { createDailyCounter, enforceLimit, resetLimits } from "../../src/server/rate-limit";
import { at, claimId } from "../helpers/period";

let tmp: string;
let http: typeof import("../../src/server/http");
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-http-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  http = await import("../../src/server/http");
  instance = await import("../../src/server/instance");
  user = instance.getAuth().register("helper_1", "へるぱ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
beforeEach(() => resetLimits());

// ヘルパだけを試すので、権限表の行は手で組む（キーは監査ログの操作名になる）
const anyRole = (key: string): Allowed => ({ key: key as Allowed["key"], rule: ["clerk", "veteran", "manager", "doctor"], external: "none", patientData: false });
const schema = z.strictObject({ name: z.string().max(5), items: z.array(z.string().max(10)).max(2).optional() });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/test", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const auditRows = () => instance.runAs(user, () => instance.getApp().audit.list(500));

describe("入力の検証", () => {
  it("スキーマに合わない入力は 400 と項目名を返し、処理に入らない", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const POST = http.route({ roles: anyRole("POST /api/test-validate"), body: schema }, handler);
    const tooLong = await POST(post({ name: "ながすぎるなまえ" }));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).fields).toEqual(["name"]);
    // 知らない項目（strict）、配列の件数の上限
    const unknown = await POST(post({ name: "a", approver: "院長" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).fields).toEqual(["approver"]);
    expect((await (await POST(post({ name: "a", items: ["1", "2", "3"] }))).json()).fields).toEqual(["items"]);
    expect(handler).not.toHaveBeenCalled();
    const ok = await POST(post({ name: "a" }));
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("params と query もスキーマで確かめる", async () => {
    const GET = http.route(
      { roles: anyRole("GET /api/test-params"), params: z.strictObject({ id: z.string().regex(/^q-[0-9a-f]{4}$/) }), query: z.strictObject({ limit: z.coerce.number().int().max(10).optional() }) },
      ({ params, query }) => ({ id: params.id, limit: query.limit ?? null }),
    );
    const get = (url: string, id: string) => GET(new Request(url, { headers: { cookie } }), { params: Promise.resolve({ id }) });
    expect(await (await get("http://localhost/api/test/q-00ff?limit=3", "q-00ff")).json()).toEqual({ id: "q-00ff", limit: 3 });
    expect((await get("http://localhost/api/test/x", "../../etc/passwd")).status).toBe(400);
    expect((await get("http://localhost/api/test/q-00ff?limit=99", "q-00ff")).status).toBe(400);
    expect((await get("http://localhost/api/test/q-00ff?other=1", "q-00ff")).status).toBe(400);
  });

  it("JSON でない content-type は 415、読めない JSON は 400", async () => {
    const POST = http.route({ roles: anyRole("POST /api/test-type"), body: schema }, () => ({ ok: true }));
    expect((await POST(post({ name: "a" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(post("{ こわれた"))).status).toBe(400);
  });

  it("大きすぎる本文は 413（content-length の申告でも、実際に読んだ量でも）", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const POST = http.route({ roles: anyRole("POST /api/test-size"), body: z.strictObject({ name: z.string() }), maxBytes: 100 }, handler);
    const big = JSON.stringify({ name: "x".repeat(500) });
    // 申告だけ大きい
    expect((await POST(post({ name: "a" }, { "content-length": "99999" }))).status).toBe(413);
    // 申告なしで流し込む（ストリーム）
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const streamed = new Request("http://localhost/api/test", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect((await POST(streamed)).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("エラーの扱い", () => {
  it("利用者に起因する誤り（UserError）は、そのステータスと文言を返す", async () => {
    const POST = http.route({ roles: anyRole("POST /api/test-user-error") }, () => {
      throw new UserError(409, "回答できない状態: 承認済み");
    });
    const r = await POST(post({}));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "回答できない状態: 承認済み" });
  });

  it("それ以外の例外は 500 と定型文で、内部のメッセージを返さない（詳細はサーバーログ）", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = http.route({ roles: anyRole("POST /api/test-internal") }, () => {
      throw new Error("ENOENT: /data/tenants/t0123456789ab/app.db が開けない");
    });
    const r = await POST(post({}));
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(JSON.parse(text).error).toBe(http.INTERNAL_ERROR);
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("/data/tenants");
    expect(log.mock.calls.flat().join("\n")).toContain("ENOENT");
    log.mockRestore();
  });

  it("ログインしていなければ 401", async () => {
    const POST = http.route({ roles: anyRole("POST /api/test-401") }, () => ({ ok: true }));
    expect((await POST(new Request("http://localhost/api/test", { method: "POST" }))).status).toBe(401);
  });

  it("許されていないロールは 403 で、処理に入らない", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const POST = http.route({ roles: { key: "POST /api/test-403" as Allowed["key"], rule: ["doctor"], external: "none", patientData: false } }, handler);
    const r = await POST(post({}));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("医師");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("開発用のルート（権限表の dev）", () => {
  it("本番では 404。本番でなくてもログインが要り、ログインしていればどのロールでも通る", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const GET = http.route({ roles: { key: "GET /api/test-dev" as Allowed["key"], rule: "dev", external: "none", patientData: false } }, handler);
    const req = (c: string | null) => new Request("http://localhost/api/test", { headers: c ? { cookie: c } : {} });
    expect((await GET(req(null))).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect((await GET(req(cookie))).status).toBe(200);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await GET(req(cookie))).status).toBe(404);
      expect((await GET(req(null))).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("監査ログ", () => {
  it("audit: false のルート（読み取り相当の POST）は、成功も失敗も残さない", async () => {
    const POST = http.route({ roles: anyRole("POST /api/test-noaudit"), body: schema, audit: false }, () => ({ ok: true }));
    const before = auditRows().length;
    expect((await POST(post({ name: "a" }))).status).toBe(200);
    expect((await POST(post({ name: "ながすぎるなまえ" }))).status).toBe(400);
    expect(auditRows().length).toBe(before);
  });

  it("GET 以外は成功も失敗も 1 行ずつ残り、本文は入らない。GET は残らない", async () => {
    const secret = "患者さんは夜間に息苦しさを訴えた";
    const body = z.strictObject({ claimId: z.string().max(20), text: z.string().max(100) });
    const POST = http.route({ roles: anyRole("POST /api/test-audit"), body, audit: { target: ({ body: b }) => b.claimId } }, ({ body: b }) => {
      if (b.claimId === "K9") throw new UserError(404, `症例がない: ${b.claimId}`);
      return { echoed: b.text };
    });
    const GET = http.route({ roles: anyRole("GET /api/test-audit") }, () => ({ ok: true }));
    const before = auditRows().length;
    await POST(post({ claimId: claimId("K1"), text: secret }));
    await POST(post({ claimId: "K9", text: secret }));
    await POST(post({ claimId: claimId("K1"), text: secret, extra: 1 }));
    await GET(new Request("http://localhost/api/test", { headers: { cookie } }));
    const rows = auditRows().slice(0, auditRows().length - before).reverse();
    expect(rows.map((r) => [r.action, r.target, r.result, r.status])).toEqual([
      ["POST /api/test-audit", claimId("K1"), "ok", 200],
      ["POST /api/test-audit", "K9", "rejected", 404],
      ["POST /api/test-audit", null, "invalid", 400],
    ]);
    // 誰が・実時刻・デモの時計は入り、本文と氏名は入らない
    expect(rows[0]).toMatchObject({ userId: user.id, role: "clerk", demoNow: at(13) });
    expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false);
    const dump = JSON.stringify(auditRows());
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(user.name);
  });
});

describe("回数制限", () => {
  it("1 分あたりの上限を超えると 429 になり、処理に入らない。1 日の数は tenant の DB に残る", async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const POST = http.route({ roles: anyRole("POST /api/test-limit"), limit: "voice" }, handler);
    const perMinute = (await import("../../src/server/rate-limit")).limits().voice.perMinute;
    for (let i = 0; i < perMinute; i++) expect((await POST(post({}))).status).toBe(200);
    const over = await POST(post({}));
    expect(over.status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(perMinute);
    // DB のファイルを直接開いて確かめる（プロセスの中の数ではない）
    const db = new Database(instance.tenantPaths(user.tenantId).dbFile, { readonly: true });
    expect(db.prepare("SELECT count FROM rate_daily WHERE bucket = 'voice' AND user_id = ?").get(user.id)).toEqual({ count: perMinute });
    db.close();
    expect(auditRows()[0]).toMatchObject({ action: "POST /api/test-limit", result: "limited", status: 429 });
  });

  it("1 日の上限は、DB を開き直しても（再起動しても）続きから数える。日付が変わると戻る", () => {
    const file = path.join(tmp, "daily.db");
    const cfg = { perMinute: 100, perDay: 2 };
    const day1 = new Date("2026-11-17T03:00:00Z");
    let db = new Database(file);
    migrate(db, APP_MIGRATIONS);
    enforceLimit("llm", "k", "u1", createDailyCounter(db), day1, cfg);
    enforceLimit("llm", "k", "u1", createDailyCounter(db), day1, cfg);
    db.close();
    resetLimits();
    db = new Database(file);
    const daily = createDailyCounter(db);
    expect(() => enforceLimit("llm", "k", "u1", daily, day1, cfg)).toThrow(/今日の上限/);
    // ほかの利用者と、次の日（日本時間）は別に数える
    expect(() => enforceLimit("llm", "k2", "u2", daily, day1, cfg)).not.toThrow();
    expect(() => enforceLimit("llm", "k", "u1", daily, new Date("2026-11-17T15:00:00Z"), cfg)).not.toThrow();
    db.close();
  });

  it("サーバー全体の 1 日の上限（perDayAll）は、別のクリニック・別の利用者の呼び出しも合わせて数え、auth.db に残る（spec U-W）", () => {
    resetLimits();
    const day1 = new Date("2026-11-17T03:00:00Z");
    const cfg = { perMinute: 100, perDay: 100, perDayAll: 3 };
    const authFile = path.join(tmp, "auth-all.db");
    let auth = openAuth(authFile);
    const tenantA = new Database(":memory:");
    const tenantB = new Database(":memory:");
    migrate(tenantA, APP_MIGRATIONS);
    migrate(tenantB, APP_MIGRATIONS);
    enforceLimit("llm", "a:u1", "u1", createDailyCounter(tenantA), day1, cfg, auth.dailyAll);
    enforceLimit("llm", "a:u2", "u2", createDailyCounter(tenantA), day1, cfg, auth.dailyAll);
    auth.close();
    auth = openAuth(authFile);
    enforceLimit("llm", "b:u3", "u3", createDailyCounter(tenantB), day1, cfg, auth.dailyAll);
    // 利用者ごとの数はまだ 1 回でも、全体で 3 回に達したので止まる
    expect(() => enforceLimit("llm", "b:u4", "u4", createDailyCounter(tenantB), day1, cfg, auth.dailyAll)).toThrow(/サーバー全体の上限/);
    // perDayAll のない種類は全体で数えない。日付が変わると戻る
    expect(() => enforceLimit("upload", "b:u4", "u4", createDailyCounter(tenantB), day1, { perMinute: 100, perDay: 100 }, auth.dailyAll)).not.toThrow();
    expect(auth.dailyAll.count("upload", "*", day1)).toBe(0);
    expect(() => enforceLimit("llm", "b:u4", "u4", createDailyCounter(tenantB), new Date("2026-11-17T15:00:00Z"), cfg, auth.dailyAll)).not.toThrow();
    auth.close();
    tenantA.close();
    tenantB.close();
  });
});

describe("接続元の IP", () => {
  it("Caddy の後ろと明示したときだけ X-Real-IP を使い、x-forwarded-for は使わない", async () => {
    const { clientIp } = await import("../../src/server/rate-limit");
    const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "198.51.100.7" } });
    expect(clientIp(req)).toBe("direct");
    process.env.RESEMEN_TRUST_PROXY = "1";
    expect(clientIp(req)).toBe("198.51.100.7");
    expect(clientIp(new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.9" } }))).toBe("unknown");
    delete process.env.RESEMEN_TRUST_PROXY;
  });
});
