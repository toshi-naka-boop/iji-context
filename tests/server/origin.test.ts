// Origin の検証（spec FR-138）：GET 以外の API は、自分の画面から来たものだけを受ける
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { originAllowed } from "../../src/server/origin";

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
