// 認可（spec FR-132〜134・FR-144）と招待制の登録（FR-137）。実際のルート（app/api/**/route.ts）を呼んで確かめる
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { at, claimId } from "../helpers/period";
import { autoConsent } from "../helpers/consent";

let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-authz-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  delete process.env.RESEMEN_OPEN_SIGNUP;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const post = (url: string, cookie: string | null, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const switchTo = async (cookie: string, role: Role) => (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", cookie, { role }));

describe("医師確認の回答と承認", () => {
  it("事務ロールでは 403。医師ロールなら通り、記録される名前と id はセッションの本人", async () => {
    const answer = (await import("../../app/api/doctor/[id]/answer/route")).POST;
    const approve = (await import("../../app/api/doctor/[id]/approve/route")).POST;
    const owner = auth().register("clinic_owner", "やまだ", "password123");
    const cookie = cookieOf(owner);
    // 代行入力の確認を 1 件、医師確認に回しておく
    const id = instance.runAs(owner, () => instance.getApp().proxySubmit(claimId("K1"), "下書き", { text: "整えた文", missing: [] }).query!.id);

    // 既定のロールは事務：回答も承認もできず、記録は変わらない
    expect(owner.role).toBe("clerk");
    const denied = await answer(post(`/api/doctor/${id}/answer`, cookie, { option: "この内容で確定する" }), params(id));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("医師");
    expect((await approve(post(`/api/doctor/${id}/approve`, cookie), params(id))).status).toBe(403);
    expect(instance.runAs(owner, () => instance.getApp().doctorQueries()[0].status)).toBe("未回答");

    // 1 人で使っているクリニックなので、役割を医師に切り替えられる
    expect((await switchTo(cookie, "doctor")).status).toBe(200);
    // 画面から名前を送っても受け取らない（知らない項目として断る）
    expect((await answer(post(`/api/doctor/${id}/answer`, cookie, { option: "この内容で確定する", answeredBy: "院長" }), params(id))).status).toBe(400);
    expect((await answer(post(`/api/doctor/${id}/answer`, cookie, { option: "この内容で確定する" }), params(id))).status).toBe(200);
    expect((await approve(post(`/api/doctor/${id}/approve`, cookie, { approver: "院長" }), params(id))).status).toBe(200);
    const q = instance.runAs(owner, () => instance.getApp().doctorQueries()[0]);
    expect(q.status).toBe("承認済み");
    expect(q.answer).toMatchObject({ answeredBy: "やまだ", answeredById: owner.id });
    expect(q.approval).toMatchObject({ approver: "やまだ", approverId: owner.id });
    // もう一度承認すると、業務上の拒否（409）として文言が返る
    const again = await approve(post(`/api/doctor/${id}/approve`, cookie), params(id));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain("承認できない状態");

    // 監査ログ：断られた操作も、通った操作も残る。役割の切替も残る
    const rows = instance.runAs(owner, () => instance.getApp().audit.list()).reverse();
    expect(rows.map((r) => [r.action, r.target, r.result, r.role])).toEqual([
      ["POST /api/doctor/[id]/answer", id, "denied", "clerk"],
      ["POST /api/doctor/[id]/approve", id, "denied", "clerk"],
      ["POST /api/auth/role", "doctor", "ok", "clerk"],
      ["POST /api/doctor/[id]/answer", id, "invalid", "doctor"],
      ["POST /api/doctor/[id]/answer", id, "ok", "doctor"],
      ["POST /api/doctor/[id]/approve", id, "ok", "doctor"],
      ["POST /api/doctor/[id]/approve", id, "rejected", "doctor"],
    ]);
    expect(auth().eventsOf(owner.tenantId).map((e) => e.event)).toContain("role.switch:clerk>doctor");
  });

  it("医師確認の id の形でないものは、記録のファイルを探す前に断る", async () => {
    const approve = (await import("../../app/api/doctor/[id]/approve/route")).POST;
    const u = auth().register("clinic_path", "ぱす", "password123");
    const cookie = cookieOf(u);
    await switchTo(cookie, "doctor");
    expect((await approve(post("/api/doctor/x/approve", cookie), params("../../auth"))).status).toBe(400);
  });
});

describe("招待制の登録", () => {
  const register = async (body: unknown) => (await import("../../app/api/auth/register/route")).POST(post("/api/auth/register", null, body));
  const invite = async (cookie: string, role: Role) => (await import("../../app/api/invites/route")).POST(post("/api/invites", cookie, { role }));

  it("招待なしの登録は断る。環境変数で開放を明示したときだけ、新しい 1 人クリニックができる", async () => {
    const closed = await register({ login: "walk_in", name: "とびこみ", password: "password123" });
    expect(closed.status).toBe(403);
    expect((await closed.json()).error).toContain("招待コード");
    expect(auth().login("walk_in", "password123")).toBeNull();

    process.env.RESEMEN_OPEN_SIGNUP = "1";
    const open = await register({ login: "walk_in", name: "とびこみ", password: "password123" });
    delete process.env.RESEMEN_OPEN_SIGNUP;
    expect(open.status).toBe(200);
    expect(open.headers.get("set-cookie")).toContain("resemen_session=");
    const u = auth().login("walk_in", "password123")!;
    expect(u.tenantId).toBe(u.id);
    expect(u.role).toBe("clerk");
  });

  it("招待コードは 1 回だけ使え、招待のクリニックとロールで登録される。DB にはコードそのものを置かない", async () => {
    const owner = auth().register("clinic_inv", "おーなー", "password123");
    const other = auth().register("clinic_other", "べつ", "password123");
    const made = await invite(cookieOf(owner), "doctor");
    expect(made.status).toBe(200);
    const { code, role } = (await made.json()) as { code: string; role: Role };
    expect(role).toBe("doctor");

    // まちがったコードは使えない
    expect((await register({ login: "dr_wrong", name: "せんせい", password: "password123", inviteCode: `${code}x` })).status).toBe(403);
    const ok = await register({ login: "dr_sato", name: "さとう", password: "password123", inviteCode: code });
    expect(ok.status).toBe(200);
    const doctor = auth().login("dr_sato", "password123")!;
    // 招待した側のクリニックに、招待のロールで入る（ほかのクリニックには入らない）
    expect(doctor).toMatchObject({ tenantId: owner.tenantId, role: "doctor" });
    expect(doctor.tenantId).not.toBe(other.tenantId);
    // 使い終わった招待は、もう使えない（別のログイン ID でも）
    const reused = await register({ login: "dr_again", name: "にどめ", password: "password123", inviteCode: code });
    expect(reused.status).toBe(403);
    expect(auth().login("dr_again", "password123")).toBeNull();

    // 同じクリニックのデータを見る（時計は tenant ごと）。ほかのクリニックとは混ざらない
    instance.runAs(owner, () => instance.getApp().advanceClock(at(23)));
    expect(instance.runAs(doctor, () => instance.getApp().now())).toBe(at(23));
    expect(instance.runAs(other, () => instance.getApp().now())).toBe(at(13));
    // 招待で入った人は自分の医療事務の行を持ち、持ち主の行（new1）とは別
    expect(instance.clerkIdOf(doctor)).toBe(doctor.id);
    expect(instance.clerkIdOf(owner)).toBe("new1");
    expect(instance.runAs(doctor, () => instance.getApp().clerk(instance.clerkIdOf(doctor)).name)).toBe("さとう");

    // ログインまわりの記録：招待の作成と使用が残り、コードそのものはどこにも残らない
    const events = auth().eventsOf(owner.tenantId).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["invite.create:doctor", "invite.use", "register"]));
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(tmp, "auth.db"), { readonly: true });
    const dump = JSON.stringify([db.prepare("SELECT * FROM invites").all(), db.prepare("SELECT * FROM auth_events").all()]);
    db.close();
    expect(dump).not.toContain(code);
  });

  it("期限の切れた招待は使えない", () => {
    const owner = auth().register("clinic_exp", "きげん", "password123");
    const inv = auth().createInvite(owner, "veteran", new Date("2026-11-01T00:00:00Z"));
    expect(() => auth().registerWithInvite("late_vet", "おそい", "password123", inv.code, new Date("2026-11-09T00:00:00Z"))).toThrow(/招待コードが使えません/);
    expect(auth().registerWithInvite("intime_vet", "まにあう", "password123", auth().createInvite(owner, "veteran", new Date("2026-11-01T00:00:00Z")).code, new Date("2026-11-07T00:00:00Z")).role).toBe("veteran");
  });

  it("利用者が 2 人以上いるクリニックでは、役割を切り替えられない。招待を作れるのは事務長だけになる", async () => {
    const owner = auth().register("clinic_two", "ふたり", "password123");
    const cookie = cookieOf(owner);
    // 1 人のあいだは、持ち主が招待を作れて、役割も切り替えられる
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    const { code } = (await (await invite(cookie, "clerk")).json()) as { code: string };
    const clerk = auth().registerWithInvite("second_clerk", "ふたりめ", "password123", code);
    // 2 人になったら切り替えられない（持ち主も、招待で入った人も）
    const denied = await switchTo(cookie, "doctor");
    expect(denied.status).toBe(403);
    expect((await switchTo(cookieOf(clerk), "doctor")).status).toBe(403);
    expect(auth().login("clinic_two", "password123")!.role).toBe("manager");
    // 事務は招待を作れず、事務長は作れる
    expect((await invite(cookieOf(clerk), "doctor")).status).toBe(403);
    expect((await invite(cookie, "doctor")).status).toBe(200);
    // 断られた切替も監査ログに残る
    const rows = instance.runAs(owner, () => instance.getApp().audit.list());
    expect(rows.filter((r) => r.action === "POST /api/auth/role").map((r) => [r.userId, r.result])).toEqual([[clerk.id, "denied"], [owner.id, "denied"], [owner.id, "ok"]]);
  });

  it("招待の一覧と取り消し：作れる人だけ。コードは返さず、別のクリニックの招待は見えず取り消せない。使用済みは取り消せない", async () => {
    const list = async (cookie: string | null) => (await import("../../app/api/invites/route")).GET(new Request("http://localhost/api/invites", { headers: cookie ? { cookie } : {} }));
    const revoke = async (cookie: string | null, id: string) => (await import("../../app/api/invites/[id]/revoke/route")).POST(post(`/api/invites/${id}/revoke`, cookie), params(id));
    type Row = { id: string; role: Role; createdAt: string; expiresAt: string; used: boolean; expired: boolean };
    const rowsOf = async (cookie: string) => (await (await list(cookie)).json()) as Row[];

    const owner = auth().register("clinic_list", "いちらん", "password123");
    const cookie = cookieOf(owner);
    const other = auth().register("clinic_list_other", "よそ", "password123");
    const otherCookie = cookieOf(other);
    expect((await list(null)).status).toBe(401);
    expect((await revoke(null, "0123456789abcdef")).status).toBe(401);

    // 1 人で使っている持ち主は、招待を作れて、一覧も見られる。コードもハッシュも返らない
    expect(await rowsOf(cookie)).toEqual([]);
    const usedCode = ((await (await invite(cookie, "veteran")).json()) as { code: string }).code;
    const keptCode = ((await (await invite(cookie, "doctor")).json()) as { code: string }).code;
    const first = await list(cookie);
    expect(first.status).toBe(200);
    const text = await first.text();
    expect(text.includes(usedCode) || text.includes(keptCode)).toBe(false);
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(tmp, "auth.db"), { readonly: true });
    const hashes = (db.prepare("SELECT code_hash FROM invites WHERE tenant_id = ?").all(owner.tenantId) as { code_hash: string }[]).map((r) => r.code_hash);
    db.close();
    expect(hashes).toHaveLength(2);
    expect(hashes.some((h) => text.includes(h))).toBe(false);
    const rows = JSON.parse(text) as Row[];
    expect(rows.map((r) => [r.role, r.used, r.expired])).toEqual([["doctor", false, false], ["veteran", false, false]]);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "expired", "expiresAt", "id", "role", "used"]);
    const [kept, used] = rows;

    // 別のクリニックからは見えず、取り消せない（「ない」として 404）
    expect(await rowsOf(otherCookie)).toEqual([]);
    expect((await revoke(otherCookie, kept.id)).status).toBe(404);
    expect(await rowsOf(cookie)).toHaveLength(2);

    // 2 人以上のクリニックでは事務長だけ。招待で入ったベテランには、一覧も取り消しもできない
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    const vet = auth().registerWithInvite("list_vet", "べてらん", "password123", usedCode);
    expect((await list(cookieOf(vet))).status).toBe(403);
    expect((await revoke(cookieOf(vet), kept.id)).status).toBe(403);
    expect((await rowsOf(cookie)).map((r) => [r.id, r.used])).toEqual([[kept.id, false], [used.id, true]]);

    // 使用済みは取り消せない（409）。id の形でないものは 400
    const usedRevoke = await revoke(cookie, used.id);
    expect(usedRevoke.status).toBe(409);
    expect((await usedRevoke.json()).error).toContain("使用済み");
    expect((await revoke(cookie, "../../auth")).status).toBe(400);
    // 未使用は取り消せる。取り消したコードでは登録できず、一覧から消える。もう一度取り消すと 404
    expect((await revoke(cookie, kept.id)).status).toBe(200);
    expect((await register({ login: "list_late", name: "おそい", password: "password123", inviteCode: keptCode })).status).toBe(403);
    expect(auth().login("list_late", "password123")).toBeNull();
    expect((await rowsOf(cookie)).map((r) => r.id)).toEqual([used.id]);
    expect((await revoke(cookie, kept.id)).status).toBe(404);

    // 期限切れの未使用は、期限切れとして並び、取り消せる
    const manager = auth().login("clinic_list", "password123")!;
    auth().createInvite(manager, "clerk", new Date("2026-01-01T00:00:00Z"));
    const expired = (await rowsOf(cookie)).find((r) => r.expired)!;
    expect(expired).toMatchObject({ role: "clerk", used: false, expired: true });
    expect((await revoke(cookie, expired.id)).status).toBe(200);

    // 監査ログ：断られた取り消しも残る。対象は招待の id で、コードはどこにも残らない
    const audit = instance.runAs(owner, () => instance.getApp().audit.list()).reverse().filter((r) => r.action === "POST /api/invites/[id]/revoke");
    expect(audit.map((r) => [r.userId, r.target, r.result])).toEqual([
      [vet.id, kept.id, "denied"],
      [owner.id, used.id, "rejected"],
      [owner.id, null, "invalid"],
      [owner.id, kept.id, "ok"],
      [owner.id, kept.id, "rejected"],
      [owner.id, expired.id, "ok"],
    ]);
    // 別のクリニックからの取り消しは、そのクリニックの側に「拒否された操作」として残る
    expect(instance.runAs(other, () => instance.getApp().audit.list()).map((r) => [r.action, r.target, r.result])).toEqual([["POST /api/invites/[id]/revoke", kept.id, "rejected"]]);
    const events = auth().eventsOf(owner.tenantId);
    expect(events.map((e) => e.event).filter((e) => e.startsWith("invite.revoke"))).toEqual(["invite.revoke:clerk", "invite.revoke:doctor"]);
    const all = JSON.stringify([audit, events, instance.runAs(other, () => instance.getApp().audit.list())]);
    expect(all.includes(usedCode) || all.includes(keptCode)).toBe(false);
  });
});

describe("監査ログの閲覧", () => {
  it("事務長だけが読める", async () => {
    const GET = (await import("../../app/api/audit/route")).GET;
    const owner = auth().register("clinic_audit", "かんさ", "password123");
    const cookie = cookieOf(owner);
    const get = () => GET(new Request("http://localhost/api/audit?limit=10", { headers: { cookie } }));
    expect((await get()).status).toBe(403);
    await switchTo(cookie, "manager");
    const r = await get();
    expect(r.status).toBe(200);
    const d = (await r.json()) as { log: { action: string }[]; auth: { event: string }[] };
    expect(d.log.map((x) => x.action)).toEqual(["POST /api/auth/role"]);
    expect(d.auth.map((x) => x.event)).toEqual(["role.switch:clerk>manager"]);
  });
});
