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


describe("今日の日付と、日付を進める操作", () => {
  it("real の今日は実際の時刻（日本時間・タイムゾーン付き）で、デモの時計の設定を読まない", () => {
    const u = auth().register("now_real", "いま", "password123", "real");
    setNow("2026-12-01T10:15:30+09:00");
    const a = appOf(u);
    expect(a.now()).toBe("2026-12-01T10:15:30+09:00");
    // デモの時計の設定が残っていても読まない
    a.setSetting("now", at(20));
    expect(a.now()).toBe("2026-12-01T10:15:30+09:00");
    // 日本時間の日付で返す（UTC ではまだ前の日）
    setNow("2026-12-01T23:30:00Z");
    expect(a.now()).toBe("2026-12-02T08:30:00+09:00");
    expect(() => a.advanceClock(at(20))).toThrow(/日付を進められません/);
  });

  it("POST /api/clock：real ではどのロールでも断る。demo では事務長が進められる（公開版でも）。公開版の demo の事務以外は断る", async () => {
    const clock = await import("../../app/api/clock/route");
    const real = auth().register("clock_real", "じつ", "password123", "real");
    const demo = auth().register("clock_demo", "でも", "password123", "demo");
    const realCookie = cookieOf(real);
    const demoCookie = cookieOf(demo);
    await switchTo(realCookie, "manager");
    const refused = await clock.POST(post("/api/clock", realCookie, { now: at(20) }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("日付を進められません");
    const realGet = await (await clock.GET(get("/api/clock", realCookie))).json();
    expect(realGet).toMatchObject({ kind: "real", canAdvance: false });

    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      // 公開版の demo：事務は断る、事務長は進められる
      expect((await clock.POST(post("/api/clock", demoCookie, { now: at(20) }))).status).toBe(403);
      expect((await (await clock.GET(get("/api/clock", demoCookie))).json())).toMatchObject({ kind: "demo", canAdvance: false });
      await switchTo(demoCookie, "manager");
      const ok = await clock.POST(post("/api/clock", demoCookie, { now: at(20) }));
      expect(ok.status).toBe(200);
      expect((await (await clock.GET(get("/api/clock", demoCookie))).json())).toEqual({ now: at(20), kind: "demo", canAdvance: true });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });
});


describe("real で、日付が変わったときに回る処理と、実際の日付での期限切れ", () => {
  const draft = (claim: string): QueryDraft => ({
    claimId: claim,
    field: "SY:心房細動",
    why: "病型の記載がない",
    question: "心房細動の病型について、診療録に記載がありません。該当するものを選んでください。",
    indicators: [{ source: "処方 2026-12-01", text: "DOAC" }],
    options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"],
    createdBy: "mentor",
  });

  it("日付が変わったリクエストで、医師確認のリマインド・保留と会議の整理が回る。同じ日のうちは回し直さない。回した日時は DB に残る", () => {
    const u = auth().register("tick_real", "じつ", "password123", "real");
    setNow("2026-12-01T10:00:00+09:00");
    const a = appOf(u); // 最初のリクエスト：その日の分を回す（会議の整理は、まだ一度も回していないので回る）
    expect(a.setting("caught_up_at")).toBe("2026-12-01T10:00:00+09:00");
    const reviews = () => {
      const db = new Database(a.paths.dbFile, { readonly: true });
      const rows = db.prepare("SELECT ran_at FROM reviews ORDER BY ran_at").all() as { ran_at: string }[];
      db.close();
      return rows.map((r) => r.ran_at);
    };
    expect(reviews()).toHaveLength(1);
    const q = createQuery(a.queryLog, draft("U1-1"), a.now());

    // 同じ日のうちは何もしない
    setNow("2026-12-01T18:00:00+09:00");
    appOf(u);
    expect(a.setting("caught_up_at")).toBe("2026-12-01T10:00:00+09:00");
    expect(readQuery(a.queryLog, q.id).remindedAt).toBeNull();

    // 翌営業日：リマインドが付く
    setNow("2026-12-02T08:00:00+09:00");
    appOf(u);
    expect(a.setting("caught_up_at")).toBe("2026-12-02T08:00:00+09:00");
    expect(readQuery(a.queryLog, q.id)).toMatchObject({ status: "未回答", remindedAt: "2026-12-02T08:00:00+09:00" });

    // 3 営業日たつと保留。会議の曜日を過ぎていれば、会議の整理も回っている
    setNow("2026-12-07T09:00:00+09:00");
    appOf(u);
    expect(readQuery(a.queryLog, q.id)).toMatchObject({ status: "保留", heldAt: "2026-12-07T09:00:00+09:00" });
    expect(reviews().length).toBe(2);
  });

  it("demo では、リクエストで何も回らない（時計を進めたときだけ）", () => {
    const u = auth().register("tick_demo", "でも", "password123", "demo");
    setNow("2026-12-01T10:00:00+09:00");
    const a = appOf(u);
    expect(a.catchUp()).toBeNull();
    expect(a.setting("caught_up_at")).toBeNull();
  });

});
