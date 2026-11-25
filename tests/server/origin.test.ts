// Origin の検証（spec FR-138）：GET 以外の API は、自分の画面から来たものだけを受ける
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { getAuth } from "../../src/server/auth-db";
import { originAllowed } from "../../src/server/origin";

let tmp: string;
beforeAll(() => {
  // 断った記録は auth.db に残るので、置き場をテスト用にする
  tmp = mkdtempSync(path.join(tmpdir(), "iji-origin-"));
  process.env.RESEMEN_DATA = tmp;
});
afterAll(() => {
  getAuth().close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
});
afterEach(() => {
  delete process.env.RESEMEN_ALLOWED_ORIGINS;
});

const req = (method: string, pathname: string, headers: Record<string, string>) =>
  new NextRequest(`http://app.internal:3000${pathname}`, { method, headers: { host: "resemen.example.com", cookie: "resemen_session=x", ...headers } });

describe("proxy.ts", () => {
  it("ちがう Origin からの POST は 403。同じ Origin は通る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cross = proxy(req("POST", "/api/doctor/q-000000000000/approve", { origin: "https://evil.example.net" }));
    expect(cross.status).toBe(403);
    expect((await cross.json()).error).toContain("受け付けられません");
    // ログイン・登録の API も同じ
    expect(proxy(req("POST", "/api/auth/login", { origin: "https://evil.example.net" })).status).toBe(403);
    expect(proxy(req("POST", "/api/clock", { origin: "null" })).status).toBe(403);
    // 前段が https を受けてアプリには http で渡すので、host が同じなら通す
    const same = proxy(req("POST", "/api/clock", { origin: "https://resemen.example.com" }));
    expect(same.status).toBe(200);
    expect(same.headers.get("x-middleware-next")).toBe("1");
    warn.mockRestore();
  });

  it("Origin がないときは Sec-Fetch-Site で決める。GET は Origin を見ない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(proxy(req("POST", "/api/clock", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(proxy(req("POST", "/api/clock", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(proxy(req("POST", "/api/clock", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(proxy(req("GET", "/api/clock", { origin: "https://evil.example.net" })).status).toBe(200);
    // どちらもない（ブラウザではないクライアント）は通す
    expect(proxy(req("POST", "/api/clock", {})).status).toBe(200);
    warn.mockRestore();
  });

  it("環境変数で許した Origin は通る", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(proxy(req("POST", "/api/clock", { origin: "https://staging.example.org" })).status).toBe(403);
    process.env.RESEMEN_ALLOWED_ORIGINS = "https://staging.example.org/, https://other.example.org";
    expect(proxy(req("POST", "/api/clock", { origin: "https://staging.example.org" })).status).toBe(200);
    warn.mockRestore();
  });

  it("断ったリクエストは監査ログ（ログインまわりの記録）に残る。誰の・どのルートかだけで、本文は残さない。回数で溢れない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = () => new Database(path.join(tmp, "auth.db"), { readonly: true });
    const rowsOf = (event: string) => {
      const db = raw();
      const rows = db.prepare("SELECT event, result, user_id AS userId, tenant_id AS tenantId FROM auth_events WHERE event = ? ORDER BY id").all(event);
      db.close();
      return rows;
    };
    const user = getAuth().register("origin_user", "おりじん", "password123");
    const session = `resemen_session=${getAuth().createSession(user.id).token}`;
    const evil = (pathname: string, cookie: string) =>
      proxy(new NextRequest(`http://app.internal:3000${pathname}`, { method: "POST", headers: { host: "resemen.example.com", cookie, origin: "https://evil.example.net", "content-type": "application/json" }, body: JSON.stringify({ note: "本文の目印XYZ" }) }));
    // セッションがあれば、その利用者とクリニックの記録として残り、事務長の画面（eventsOf）に出る
    expect(evil("/api/chart", session).status).toBe(403);
    expect(getAuth().eventsOf(user.tenantId)).toEqual([expect.objectContaining({ event: "origin:POST /api/chart", result: "denied", userId: user.id })]);
    // セッションがない（または読めない）ときは、利用者は不明（null）で残る
    expect(evil("/api/doctor/q-1/approve", "resemen_session=unknown-token").status).toBe(403);
    expect(rowsOf("origin:POST /api/doctor/q-1/approve")).toEqual([{ event: "origin:POST /api/doctor/q-1/approve", result: "denied", userId: null, tenantId: null }]);
    // 本文は、どの記録にも残らない
    const db = raw();
    expect(JSON.stringify(db.prepare("SELECT * FROM auth_events").all())).not.toContain("XYZ");
    db.close();
    // 同じ相手からは 1 分あたりの上限までしか残さない（断ること自体は続ける）
    for (let i = 0; i < 50; i++) expect(evil("/api/clock", session).status).toBe(403);
    // この利用者の記録は、先の 1 件と合わせて上限の 20 件まで
    expect(getAuth().eventsOf(user.tenantId)).toHaveLength(20);
    // 長いパスや改行は切って残す
    expect(evil(`/api/${"a".repeat(300)}%0A`, "").status).toBe(403);
    const ldb = raw();
    const long = ldb.prepare("SELECT event FROM auth_events WHERE event LIKE 'origin:POST /api/aaa%'").get() as { event: string };
    ldb.close();
    expect(long.event.length).toBeLessThanOrEqual(100);
    expect(long.event).not.toMatch(/[\u0000-\u001f]/);
    warn.mockRestore();
  });
});

describe("originAllowed", () => {
  const base = { method: "POST", pathname: "/api/x", host: "a.example.com", secFetchSite: null, allowed: [] };
  it("host の一部が同じだけの Origin や、読めない Origin は通さない", () => {
    expect(originAllowed({ ...base, origin: "https://a.example.com" })).toBe(true);
    expect(originAllowed({ ...base, origin: "https://a.example.com.evil.net" })).toBe(false);
    expect(originAllowed({ ...base, origin: "https://evil.net/a.example.com" })).toBe(false);
    expect(originAllowed({ ...base, origin: "こわれた値" })).toBe(false);
    expect(originAllowed({ ...base, origin: "https://a.example.com", host: null })).toBe(false);
  });
});
