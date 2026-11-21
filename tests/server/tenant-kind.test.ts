// クリニックの種類（demo／real。2026-11-22 利用者の判断）：作るときに決め、変えない。招待で入った人は種類を引き継ぐ。
// real は今日が実際の日付（日本時間）で進められず、作り物のデータ（院内ルールの種・K6 の地域ルール・見本の UKE・練習問題）を入れない・見せない。
// 日付が変わったリクエストで、医師確認のリマインド・保留と会議の整理が回る。実際のルート（app/api/**/route.ts）を呼んで確かめる
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listKnowledge } from "../../src/lifecycle/store";
import { createQuery, readQuery, type QueryDraft } from "../../src/query/doctor-query";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { at, claimId } from "../helpers/period";
import { autoConsent } from "../helpers/consent";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-tenant-kind-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  delete process.env.RESEMEN_OPEN_SIGNUP;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const post = (url: string, cookie: string | null, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const switchTo = async (cookie: string, role: Role) => (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", cookie, { role }));
const appOf = (u: User) => instance.runAs(u, () => instance.getApp());
/** 時計（Date）だけを差し替える。日本時間で書く */
const setNow = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const upload = (cookie: string, bytes: Uint8Array) => {
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart]), "upload.UKE");
  return new Request("http://localhost/api/uke/upload", { method: "POST", headers: { cookie }, body: form });
};
const SAMPLE = readFileSync(path.join(repo, "fixtures", "uke", "kokuhoren.UKE"));

describe("クリニックの種類", () => {
  it("招待なしの登録で選んだ種類がクリニックに付き、招待で入った人はそのクリニックの種類になる。招待のときに種類は選べない", async () => {
    const register = (await import("../../app/api/auth/register/route")).POST;
    process.env.RESEMEN_OPEN_SIGNUP = "1";
    try {
      const made = await register(post("/api/auth/register", null, { login: "kind_real", name: "じつざい", password: "password123", kind: "real" }));
      expect(made.status).toBe(200);
      const owner = auth().login("kind_real", "password123")!;
      expect(auth().tenantKind(owner.tenantId)).toBe("real");
      expect(appOf(owner).kind).toBe("real");

      const inviteRes = await (await import("../../app/api/invites/route")).POST(post("/api/invites", cookieOf(owner), { role: "doctor" }));
      const { code } = (await inviteRes.json()) as { code: string };
      // 招待コードと種類を両方送ると断る（招待したクリニックの種類になる）
      expect((await register(post("/api/auth/register", null, { login: "kind_join_x", name: "まちがい", password: "password123", inviteCode: code, kind: "demo" }))).status).toBe(400);
      const joined = await register(post("/api/auth/register", null, { login: "kind_join", name: "しょうたい", password: "password123", inviteCode: code }));
      expect(joined.status).toBe(200);
      expect((await joined.json()).kind).toBe("real");
      const doctor = auth().login("kind_join", "password123")!;
      expect(doctor.tenantId).toBe(owner.tenantId);
      expect(appOf(doctor).kind).toBe("real");
    } finally {
      delete process.env.RESEMEN_OPEN_SIGNUP;
    }
  });

  it("種類を渡さない登録（テスト・スクリプト）と、ログインなしの既定のアプリは demo", () => {
    const u = auth().register("kind_default", "きてい", "password123");
    expect(auth().tenantKind(u.tenantId)).toBe("demo");
    expect(appOf(u).kind).toBe("demo");
    expect(instance.getApp().kind).toBe("demo");
  });
});
