// クリニックの種類（demo／real。2026-11-22 利用者の判断）：作るときに決め、変えない。招待で入った人は種類を引き継ぐ。
// real は今日が実際の日付（日本時間）で進められず、作り物のデータ（院内ルールの種・K6 の地域ルール・見本の UKE・練習問題）を入れない・見せない。
// 日付が変わったリクエストで、医師確認のリマインド・保留と会議の整理が回る。実際のルート（app/api/**/route.ts）を呼んで確かめる
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listKnowledge } from "../../src/lifecycle/store";
import { createQuery, readQuery, type QueryDraft } from "../../src/query/doctor-query";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { readUke, writeUke } from "../../src/uke/uke";
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
const UKE_DIR = path.join(repo, "fixtures", "uke");
const SAMPLE = readFileSync(path.join(UKE_DIR, "kokuhoren.UKE"));
/** 同梱のどれとも内容が違う UKE（見本の 1 枚目を、架空の別の患者にしたもの） */
const OWN = (() => {
  const f = readUke(SAMPLE);
  return writeUke({ ...f, receipts: [{ ...f.receipts[0], patient: { ...f.receipts[0].patient, name: "架空 桐子", birth: "19480808" } }] });
})();

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

describe("使い方が未定のクリニック（種類を持つ前に作られたもの）", () => {
  /** 種類を持つ前のクリニックにする（行がないクリニックは未定。マイグレーションのあとの「未定」の行と同じ扱い） */
  const forget = (tenantId: string) => {
    const db = new Database(path.join(tmp, "auth.db"));
    db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
    db.close();
  };
  const json = async (r: Response) => [r.status, await r.json()] as const;

  it("選ぶまでは、作り物を入れず、今日は実際の日付で、点検などの操作は断る。事務長以外には「お待ちください」", async () => {
    const owner = auth().register("und_owner", "もちぬし", "password123", "demo");
    const invite = auth().createInvite(owner, "clerk");
    const member = auth().registerWithInvite("und_member", "なかま", "password123", invite.code);
    forget(owner.tenantId);
    expect(auth().tenantKind(owner.tenantId)).toBe("undecided");
    setNow("2026-12-01T10:00:00+09:00");
    // 未定で初めて開いても、作り物の種は入らない。今日は実際の日付
    const a = appOf(owner);
    expect(a.kind).toBe("undecided");
    expect([...new Set(listKnowledge(a.store).map((m) => m.layer))]).toEqual(["制度"]);
    expect(a.now()).toBe("2026-12-01T10:00:00+09:00");
    expect(a.cases()).toEqual([]);
    expect(() => a.advanceClock(at(20))).toThrow(/日付を進められません/);

    const memberCookie = cookieOf(member);
    const [status, body] = await json(await (await import("../../app/api/cases/route")).GET(get("/api/cases", memberCookie)));
    expect([status, body]).toEqual([409, { error: "事務長がこのクリニックの使い方を選ぶまでお待ちください", tenant: "undecided" }]);
    expect((await json(await (await import("../../app/api/auth/me/route")).GET(get("/api/auth/me", memberCookie))))[1]).toMatchObject({ tenantKind: "undecided", canChooseKind: false });
    expect((await json(await (await import("../../app/api/clock/route")).GET(get("/api/clock", memberCookie))))).toEqual([200, { now: "2026-12-01T10:00:00+09:00", kind: "undecided", canAdvance: false }]);
    // 事務以外の人は選べない
    expect((await (await import("../../app/api/tenant/kind/route")).POST(post("/api/tenant/kind", memberCookie, { kind: "real" }))).status).toBe(403);
  });

  it("事務長が一度だけ選べる。選んだあとは変えられず、選んだ種類で開き直る", async () => {
    const owner = auth().register("und_choose", "もちぬし", "password123", "real");
    const invite = auth().createInvite(owner, "manager");
    const manager = auth().registerWithInvite("und_manager", "じむちょう", "password123", invite.code);
    forget(owner.tenantId);
    appOf(owner); // 未定のまま開いておく
    const cookie = cookieOf(manager);
    expect((await json(await (await import("../../app/api/auth/me/route")).GET(get("/api/auth/me", cookie))))[1]).toMatchObject({ tenantKind: "undecided", canChooseKind: true });
    const choose = (await import("../../app/api/tenant/kind/route")).POST;
    expect((await choose(post("/api/tenant/kind", cookie, {}))).status).toBe(400);
    expect(await json(await choose(post("/api/tenant/kind", cookie, { kind: "demo" })))).toEqual([200, { kind: "demo" }]);
    expect(auth().tenantKind(owner.tenantId)).toBe("demo");
    // 開き直して demo になり、作り物の種が入る
    expect(appOf(owner).kind).toBe("demo");
    expect([...new Set(listKnowledge(appOf(owner).store).map((m) => m.layer))].sort()).toEqual(["制度", "地域", "院内"].sort());
    expect((await (await import("../../app/api/cases/route")).GET(get("/api/cases", cookieOf(owner)))).status).toBe(200);
    // 2 回目は断る
    const again = await json(await choose(post("/api/tenant/kind", cookie, { kind: "real" })));
    expect(again[0]).toBe(409);
    expect(auth().tenantKind(owner.tenantId)).toBe("demo");
  });

  it("1 人で使っているクリニックは、持ち主が（事務の役割のままでも）選べる", async () => {
    const solo = auth().register("und_solo", "ひとり", "password123", "demo");
    forget(solo.tenantId);
    const cookie = cookieOf(solo);
    const me = (await json(await (await import("../../app/api/auth/me/route")).GET(get("/api/auth/me", cookie))))[1];
    expect(me).toMatchObject({ role: "clerk", tenantKind: "undecided", canChooseKind: true });
    expect((await json(await (await import("../../app/api/cases/route")).GET(get("/api/cases", cookie))))[1]).toMatchObject({ tenant: "undecided", error: expect.stringContaining("先に") });
    expect((await (await import("../../app/api/tenant/kind/route")).POST(post("/api/tenant/kind", cookie, { kind: "real" }))).status).toBe(200);
    expect(appOf(solo).kind).toBe("real");
  });
});

describe("未定から real を選んだクリニックの、作り物の知識（印で除外する。2026-11-22 利用者の判断）", () => {
  const forget = (tenantId: string) => {
    const db = new Database(path.join(tmp, "auth.db"));
    db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
    db.close();
  };
  const choose = async (u: User, kind: "demo" | "real") => (await import("../../app/api/tenant/kind/route")).POST(post("/api/tenant/kind", cookieOf(u), { kind }));
  const ids = (u: User) => listKnowledge(appOf(u).store).map((m) => m.id);
  /** デモのときに作り物が入り、会議の整理で議題になり、K6 の地域ルールが承認されて Skill になったクリニック（を未定にしたもの） */
  async function oldDemoClinic(login: string) {
    const u = auth().register(login, "まえから", "password123", "demo");
    const a = appOf(u);
    const k6 = listKnowledge(a.store).find((m) => m.layer === "地域" && m.source_event.ref.startsWith("査定:K6-"))!;
    expect(k6).toBeDefined();
    a.verify(k6.id, true);
    // 実在の利用者が作った知識（作り物でない）
    const own = a.propose({ summary: "まえからの院内の決まり", body: "本文" }) as { id: string };
    // 種の古い承認済みのものが、使われない期間（180 日）で会議の議題になる
    a.advanceClock(at(20));
    const agendaBefore = a.agenda().items.map((i) => i.knowledgeId);
    expect(agendaBefore.some((id) => id.startsWith("in-house/seed-") || id.includes("seed-"))).toBe(true);
    const before = listKnowledge(a.store).map((m) => [m.id, m.status, m.history.length]);
    forget(u.tenantId);
    return { u, k6: k6.id, own: own.id, before };
  }

  it("real を選ぶと、作り物の知識は判断・会議・トリガー・Skill から外れ、一覧では作り物として見える。状態と history は変わらない", async () => {
    const { u, k6, own, before } = await oldDemoClinic("sample_k_real");
    expect((await choose(u, "real")).status).toBe(200);
    const a = appOf(u);
    // 判断に使う一覧（ローカルルール欄・提出結果の集計・トリガーが読む）から外れる。実在の利用者が作った知識は残る
    expect(ids(u).some((id) => id.includes("seed-"))).toBe(false);
    expect(ids(u)).not.toContain(k6);
    expect(ids(u)).toContain(own);
    // 状態と history は変わらない
    expect(listKnowledge(a.store, { withExcluded: true }).map((m) => [m.id, m.status, m.history.length])).toEqual(before);
    // 一覧では作り物として見える
    const list = a.knowledgeList();
    expect(list.filter((k) => k.sample).map((k) => k.id)).toEqual(expect.arrayContaining([k6, expect.stringContaining("seed-01")]));
    expect(list.find((k) => k.id === own)?.sample).toBe(false);
    // Skill（メンターが読む）に作り物の地域ルールがない
    expect(readdirSync(a.store.skillsDir).some((n) => n.includes(k6.split("/")[1]))).toBe(false);
    // 会議の議題に作り物がなく、日付が変わって会議の整理が回っても出ない
    expect(a.agenda().items.filter((i) => i.knowledgeId.includes("seed-") || i.knowledgeId === k6)).toEqual([]);
    setNow("2027-06-01T10:00:00+09:00");
    appOf(u);
    expect(appOf(u).agenda().items.filter((i) => i.knowledgeId.includes("seed-") || i.knowledgeId === k6)).toEqual([]);
    expect(listKnowledge(appOf(u).store, { withExcluded: true }).filter((m) => m.id.includes("seed-") || m.id === k6).map((m) => [m.id, m.status, m.history.length])).toEqual(before.filter(([id]) => String(id).includes("seed-") || id === k6));
  });

  it("real を選ぶと、見本の請求を指す問題・医師確認・ベテランへの問いは、一覧に出ない（消さない）。demo を選ぶと出たまま", async () => {
    const make = async (login: string) => {
      const u = auth().register(login, "まえから", "password123", "demo");
      const a = appOf(u);
      a.start("new1", claimId("K1"));
      createQuery(a.queryLog, { claimId: claimId("K4"), field: "SY:心房細動", why: "病型の記載がない", question: "心房細動の病型について、診療録に記載がありません。該当するものを選んでください。", indicators: [{ source: "処方", text: "DOAC" }], options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"], createdBy: "mentor" }, a.now());
      a.peerToHuman("new1", "K1 の算定で迷った点", claimId("K1"));
      forget(u.tenantId);
      return u;
    };
    const shown = (u: User) => {
      const a = appOf(u);
      return { questions: a.questionsOf("new1").length, doctor: a.doctorQueries().length, peer: a.peerListFor({ clerkId: "new1", role: "veteran" }).length };
    };
    const real = await make("sample_rec_real");
    expect((await choose(real, "real")).status).toBe(200);
    expect(shown(real)).toEqual({ questions: 0, doctor: 0, peer: 0 });
    // 消してはいない
    const db = new Database(instance.tenantPaths(real.tenantId).dbFile, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM peer_questions").get()).toEqual({ n: 1 });
    db.close();
    expect(readdirSync(appOf(real).queryLog.dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);

    const demo = await make("sample_rec_demo");
    expect((await choose(demo, "demo")).status).toBe(200);
    expect(shown(demo)).toEqual({ questions: 1, doctor: 1, peer: 1 });
  });

  it("デモのときに回答して反映されずに残った作り物の議題は、real を選んだあとの整理で反映しない（状態・history は変わらず、修正の候補もできない）", async () => {
    const { u, before } = await oldDemoClinic("sample_k_recover");
    // 回答を保存したあと、反映の前に止まった状態にする（回答 2 ＝ 外す・直す側）
    const dbFile = instance.tenantPaths(u.tenantId).dbFile;
    const db = new Database(dbFile);
    const item = db.prepare("SELECT item_id, knowledge_id FROM digest_items WHERE knowledge_id LIKE '%seed-%' AND answer IS NULL LIMIT 1").get() as { item_id: string; knowledge_id: string };
    expect(item).toBeDefined();
    db.prepare("UPDATE digest_items SET answer = 2, free_text = '直す', answered_at = ? WHERE item_id = ?").run(at(20), item.item_id);
    db.close();
    expect((await choose(u, "real")).status).toBe(200);
    // 日付が変わって会議の整理が回る（答えの拾い直しを含む）
    setNow("2027-06-01T10:00:00+09:00");
    appOf(u);
    const a = appOf(u);
    a.runMeeting();
    const all = listKnowledge(a.store, { withExcluded: true });
    expect(all.filter((m) => m.id.includes("seed-")).map((m) => [m.id, m.status, m.history.length])).toEqual(before.filter(([id]) => String(id).includes("seed-")));
    expect(all.some((m) => m.relates_to === item.knowledge_id)).toBe(false);
    // 直接回答しても反映しない
    const fresh = new Database(dbFile, { readonly: true });
    const other = fresh.prepare("SELECT item_id FROM digest_items WHERE knowledge_id LIKE '%seed-%' AND answer IS NULL LIMIT 1").get() as { item_id: string } | undefined;
    fresh.close();
    if (other) expect(a.answerAgenda(other.item_id, 2, "直す")).toEqual({ status: "stale" });
    expect(listKnowledge(a.store, { withExcluded: true }).filter((m) => m.id.includes("seed-")).map((m) => [m.id, m.status, m.history.length])).toEqual(before.filter(([id]) => String(id).includes("seed-")));
  });

  it("demo を選んだときと、新しい real のクリニックでは変わらない", async () => {
    const { u, k6 } = await oldDemoClinic("sample_k_demo");
    expect((await choose(u, "demo")).status).toBe(200);
    expect(ids(u)).toContain(k6);
    expect(ids(u).some((id) => id.includes("seed-"))).toBe(true);
    expect(appOf(u).knowledgeList().some((k) => k.sample)).toBe(false);

    const fresh = auth().register("sample_k_new", "あたらしい", "password123", "real");
    const a = appOf(fresh);
    const own = a.propose({ summary: "あたらしい院内の決まり", body: "本文" }) as { id: string };
    expect(listKnowledge(a.store).map((m) => m.id)).toEqual(listKnowledge(a.store, { withExcluded: true }).map((m) => m.id));
    expect(ids(fresh)).toContain(own.id);
    expect(a.knowledgeList().some((k) => k.sample)).toBe(false);
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

describe("real に作り物のデータを入れない・見せない", () => {
  it("院内ルールの種・K6 の地域ルール・見本の UKE・作り物の患者・練習問題が、real にはなく demo にはある", async () => {
    const real = auth().register("data_real", "じつ", "password123", "real");
    const demo = auth().register("data_demo", "でも", "password123", "demo");
    const layers = (u: User) => [...new Set(listKnowledge(appOf(u).store).map((m) => m.layer))].sort();
    expect(layers(demo)).toEqual(expect.arrayContaining(["院内", "地域", "制度"]));
    expect(layers(real)).toEqual(["制度"]);

    const cookie = cookieOf(real);
    const json = async (r: Response) => {
      expect(r.status).toBe(200);
      return r.json();
    };
    expect(await json(await (await import("../../app/api/cases/route")).GET(get("/api/cases", cookie)))).toEqual([]);
    expect(await json(await (await import("../../app/api/uke/route")).GET(get("/api/uke", cookie)))).toEqual([]);
    expect(await json(await (await import("../../app/api/patients/route")).GET(get("/api/patients", cookie)))).toEqual([]);
    expect(await json(await (await import("../../app/api/drills/route")).GET(get("/api/drills", cookie)))).toMatchObject({ fix: [], doctor: [], unavailable: expect.stringContaining("デモ") });
    // 見本の名前では取り込めない。練習問題は始められない
    expect((await (await import("../../app/api/uke/route")).POST(post("/api/uke", cookie, { name: "kokuhoren.UKE" }))).status).toBe(400);
    expect(() => appOf(real).startDrill("new1", "drill-1")).toThrow(/デモのクリニックだけ/);
    await switchTo(cookie, "doctor");
    expect(await json(await (await import("../../app/api/doctor/facts/route")).GET(get("/api/doctor/facts", cookie)))).toEqual([]);
    await switchTo(cookie, "clerk");
    // 患者マスタにも作り物の患者が入らない
    const db = new Database(instance.tenantPaths(real.tenantId).dbFile, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM patients").get()).toEqual({ n: 0 });
    db.close();

    // demo には見本の請求が並ぶ
    expect(appOf(demo).cases().map((c) => c.claimId)).toContain(claimId("K1"));
    expect(appOf(demo).drills().fix.length).toBeGreaterThan(0);
  });

  it("real では見本の通知（K6）を読ませない（AI のサービスに送る前に断る）", async () => {
    const notice = (await import("../../app/api/notice/route")).POST;
    const real = auth().register("notice_real", "じつ", "password123", "real");
    const cookie = cookieOf(real);
    await switchTo(cookie, "veteran");
    const r = await notice(post("/api/notice", cookie, { sample: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("デモで試すクリニックだけ");
  });

  it("real では見本の UKE をダウンロードさせず、同梱の UKE と同じ内容のアップロードを断る。ほかの UKE は取り込める（請求の番号はアプリが振る）", async () => {
    const real = auth().register("sample_real", "じつ", "password123", "real");
    const cookie = cookieOf(real);
    expect((await (await import("../../app/api/uke/sample/route")).GET(get("/api/uke/sample?name=kokuhoren.UKE", cookie))).status).toBe(404);
    const send = (await import("../../app/api/uke/upload/route")).POST;
    const { resetLimits } = await import("../../src/server/rate-limit");
    for (const f of readdirSync(UKE_DIR).filter((x) => x.endsWith(".UKE"))) {
      resetLimits();
      const r = await send(upload(cookie, readFileSync(path.join(UKE_DIR, f))));
      expect([f, r.status]).toEqual([f, 400]);
      expect((await r.json()).error).toContain("同梱の見本");
    }
    expect(appOf(real).ukeList("new1")).toEqual([]);
    resetLimits();
    const r = await send(upload(cookie, OWN));
    expect(r.status).toBe(200);
    const list = (await r.json()) as { name: string; uploaded: boolean; receipts: { claimId: string }[] }[];
    expect(list.map((u) => u.uploaded)).toEqual([true]);
    expect(list[0].receipts.map((x) => x.claimId)).toEqual(["U1-1"]);
    // demo では今までどおり見本をダウンロードできる
    const demo = auth().register("sample_demo", "でも", "password123", "demo");
    expect((await (await import("../../app/api/uke/sample/route")).GET(get("/api/uke/sample?name=kokuhoren.UKE", cookieOf(demo)))).status).toBe(200);
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

  it("失敗したら同じ日のうちに次のリクエストで回し直す。続けて失敗するときは間隔を空け、回せたら元に戻る", async () => {
    const { openApp } = await import("../../src/server/app");
    const { writeFileSync, mkdirSync, unlinkSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "iji-catchup-"));
    // 医師確認の記録の置き場をファイルにして、読めない（一時的な失敗）ようにする
    const logDir = path.join(dir, "query-log");
    writeFileSync(logDir, "");
    const a = openApp({ root: repo, dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: logDir }, { kind: "real" });
    try {
      setNow("2026-12-01T10:00:00+09:00");
      expect(() => a.catchUp()).toThrow();
      // 1 回目の失敗のあとは、次のリクエストですぐ回し直す（まだ失敗）
      setNow("2026-12-01T10:00:01+09:00");
      expect(() => a.catchUp()).toThrow();
      // 2 回続けて失敗したので、1 分は回さない
      setNow("2026-12-01T10:00:30+09:00");
      expect(a.catchUp()).toBeNull();
      // 直ったあと、間隔が過ぎれば同じ日のうちに回せる
      unlinkSync(logDir);
      mkdirSync(logDir);
      setNow("2026-12-01T10:01:02+09:00");
      expect(a.catchUp()).not.toBeNull();
      expect(a.setting("caught_up_at")).toBe("2026-12-01T10:01:02+09:00");
      // 回せたら、その日のうちはもう回さない
      setNow("2026-12-01T11:00:00+09:00");
      expect(a.catchUp()).toBeNull();
    } finally {
      a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("demo では、リクエストで何も回らない（時計を進めたときだけ）", () => {
    const u = auth().register("tick_demo", "でも", "password123", "demo");
    setNow("2026-12-01T10:00:00+09:00");
    const a = appOf(u);
    expect(a.catchUp()).toBeNull();
    expect(a.setting("caught_up_at")).toBeNull();
  });

  it("real では、要介護認定の期限切れ（P07）が実際の日付で出る。demo の時計では出ない", async () => {
    const real = auth().register("exp_real", "じつ", "password123", "real");
    const cookie = cookieOf(real);
    setNow("2026-12-01T10:00:00+09:00");
    expect((await (await import("../../app/api/uke/upload/route")).POST(upload(cookie, OWN))).status).toBe(200);
    const a = appOf(real);
    const claim = a.cases()[0].claimId;
    a.savePatientFact(claim, "new1", { key: "careLevel", value: 2, source: "介護保険証", validUntil: "2026-12-05" });
    const p07 = () => appOf(real).patientProfile(claim).findings.filter((f) => f.checkId === "P07").map((f) => f.messageKey);
    expect(p07()).toEqual(["P07.expiring_soon"]);
    setNow("2026-12-10T10:00:00+09:00");
    expect(p07()).toEqual(["P07.expired"]);

    // demo は今までどおりデモの時計で見る（実際の日付が進んでも、期限切れにならない）
    const demo = auth().register("exp_demo", "でも", "password123", "demo");
    const d = appOf(demo);
    d.savePatientFact(claimId("K4"), "new1", { key: "careLevel", value: 2, source: "介護保険証", validUntil: "2026-10-20" });
    const demoP07 = () => appOf(demo).patientProfile(claimId("K4")).findings.filter((f) => f.checkId === "P07").map((f) => f.messageKey);
    expect(demoP07()).toEqual(["P07.expiring_soon"]);
    setNow("2027-01-10T10:00:00+09:00");
    expect(demoP07()).toEqual(["P07.expiring_soon"]);
  });
});
