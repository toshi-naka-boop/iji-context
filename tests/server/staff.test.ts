// 職員の一覧・役割の変更・停止・再開（採点 r1 事務長 #2）。実際のルート（app/api/staff/**）を呼んで確かめる
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";

let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-staff-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const post = (url: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async (cookie: string) => (await import("../../app/api/staff/route")).GET(new Request("http://localhost/api/staff", { headers: { cookie } }));
const setRole = async (cookie: string, id: string, role: Role) => (await import("../../app/api/staff/[id]/role/route")).POST(post(`/api/staff/${id}/role`, cookie, { role }), params(id));
const suspend = async (cookie: string, id: string) => (await import("../../app/api/staff/[id]/suspend/route")).POST(post(`/api/staff/${id}/suspend`, cookie), params(id));
const handOver = async (cookie: string, id: string, password: string) => (await import("../../app/api/staff/[id]/owner/route")).POST(post(`/api/staff/${id}/owner`, cookie, { password }), params(id));
const issue = async (cookie: string, id: string) => (await import("../../app/api/staff/[id]/password/route")).POST(post(`/api/staff/${id}/password`, cookie), params(id));
const changeOwn = async (cookie: string, current: string, next: string) => (await import("../../app/api/auth/password/route")).POST(post("/api/auth/password", cookie, { current, next }));
const me = async (cookie: string) => (await import("../../app/api/auth/me/route")).GET(new Request("http://localhost/api/auth/me", { headers: { cookie } }));
const resume = async (cookie: string, id: string) => (await import("../../app/api/staff/[id]/resume/route")).POST(post(`/api/staff/${id}/resume`, cookie), params(id));

/** 持ち主（事務長）と、招待で入った人たち */
function clinic(prefix: string, kind: "demo" | "real" = "demo") {
  const owner = auth().switchRole(auth().register(`${prefix}_owner`, "おーなー", "password123", kind), "manager");
  const join = (login: string, role: Role) => auth().registerWithInvite(`${prefix}_${login}`, login, "password123", auth().createInvite(owner, role).code);
  return { owner, join };
}

describe("職員の管理", () => {
  it("事務長と持ち主だけが一覧を見られる。ほかの役割は 403。ほかのクリニックの人は出ない", async () => {
    const { owner, join } = clinic("st_list");
    const clerk = join("clerk", "clerk");
    const other = clinic("st_list_other").owner;
    const r = await list(cookieOf(owner));
    expect(r.status).toBe(200);
    const rows = (await r.json()) as { id: string; role: Role; owner: boolean; self: boolean; disabled: boolean }[];
    expect(rows.map((x) => [x.id, x.role, x.owner, x.self, x.disabled])).toEqual([
      [owner.id, "manager", true, true, false],
      [clerk.id, "clerk", false, false, false],
    ]);
    expect(JSON.stringify(rows)).not.toContain("scrypt");
    expect((await list(cookieOf(clerk))).status).toBe(403);
    // ほかのクリニックの人は「いない」
    expect((await setRole(cookieOf(other), clerk.id, "veteran")).status).toBe(404);
    expect((await suspend(cookieOf(other), clerk.id)).status).toBe(404);
  });

  it("停止した人はログインできず、セッションも切れる。再開すると、またログインできる", async () => {
    const { owner, join } = clinic("st_stop");
    const clerk = join("clerk", "clerk");
    const clerkCookie = cookieOf(clerk);
    const token = clerkCookie.split("=")[1];
    expect(auth().userOfSession(token)?.id).toBe(clerk.id);
    expect((await suspend(cookieOf(owner), clerk.id)).status).toBe(200);
    expect(auth().userOfSession(token)).toBeNull();
    expect(auth().login("st_stop_clerk", "password123")).toBeNull();
    // 停止した人の呼び出しはログインしていない扱い
    expect((await list(clerkCookie)).status).toBe(401);
    expect((await resume(cookieOf(owner), clerk.id)).status).toBe(200);
    expect(auth().login("st_stop_clerk", "password123")?.id).toBe(clerk.id);
    // 監査ログ：対象は職員の id だけ。auth_events には操作の名前だけ
    const rows = instance.runAs(owner, () => instance.getApp().audit.list()).reverse().filter((r) => r.action.startsWith("POST /api/staff"));
    expect(rows.map((r) => [r.action, r.target, r.result])).toEqual([
      ["POST /api/staff/[id]/suspend", clerk.id, "ok"],
      ["POST /api/staff/[id]/resume", clerk.id, "ok"],
    ]);
    expect(auth().eventsOf(owner.tenantId).map((e) => e.event)).toEqual(expect.arrayContaining(["staff.suspend", "staff.resume"]));
  });

  it("自分と持ち主は停止できず、事務長がいなくなる停止・役割の変更は断る", async () => {
    const { owner, join } = clinic("st_keep");
    const manager = join("mgr", "manager");
    const mc = cookieOf(manager);
    expect((await suspend(mc, manager.id)).status).toBe(409);
    expect((await suspend(mc, owner.id)).status).toBe(409);
    // 持ち主の役割は、持ち主だけが変えられる（事務長は変えられない。採点 r2 エンジニアの上司 #7）
    expect((await setRole(mc, owner.id, "clerk")).status).toBe(403);
    expect(auth().login("st_keep_owner", "password123")!.role).toBe("manager");
    // 事務長が 2 人のうちは、1 人を事務にできる。最後の 1 人は事務にも停止にもできない
    expect((await setRole(cookieOf(owner), owner.id, "clerk")).status).toBe(200);
    const last = await setRole(mc, manager.id, "clerk");
    expect(last.status).toBe(409);
    expect((await last.json()).error).toContain("事務長がいなくなる");
    expect(auth().activeManagers(owner.tenantId)).toBe(1);
    // 持ち主は事務になっても職員を管理できる（事務長を戻せる）
    const oc = cookieOf(owner);
    expect((await list(oc)).status).toBe(200);
    expect((await setRole(oc, owner.id, "manager")).status).toBe(200);
    expect((await suspend(oc, manager.id)).status).toBe(200);
    expect((await setRole(oc, owner.id, "veteran")).status).toBe(409);
    // 断った操作も監査ログに残る
    const rows = instance.runAs(owner, () => instance.getApp().audit.list()).filter((r) => r.action.startsWith("POST /api/staff"));
    expect(rows.filter((r) => r.result === "rejected").map((r) => r.target)).toEqual([owner.id, manager.id, owner.id, manager.id]);
  });

  it("事務・ベテランは役割を変えられない。実在のデータで使うクリニックでは、医師の役割には変えられず、医師もほかの役割にしない", async () => {
    const { owner, join } = clinic("st_real", "real");
    const vet = join("vet", "veteran");
    const doctor = join("doc", "doctor");
    expect((await setRole(cookieOf(vet), vet.id, "manager")).status).toBe(403);
    const oc = cookieOf(owner);
    expect((await setRole(oc, vet.id, "doctor")).status).toBe(403);
    expect((await setRole(oc, doctor.id, "clerk")).status).toBe(403);
    expect((await setRole(oc, vet.id, "clerk")).status).toBe(200);
    expect(auth().login("st_real_vet", "password123")!.role).toBe("clerk");
    // デモで試すクリニックでは、医師の役割にも変えられる
    const demo = clinic("st_demo");
    const c = demo.join("clerk", "clerk");
    expect((await setRole(cookieOf(demo.owner), c.id, "doctor")).status).toBe(200);
  });

  it("持ち主は、パスワードを入れ直して、ほかの事務長に持ち主を引き継げる。記録にはパスワードを残さない（採点 r2 事務長 #3）", async () => {
    const { owner, join } = clinic("st_owner");
    const mgr = join("mgr", "manager");
    const clerk = join("clerk", "clerk");
    const oc = cookieOf(owner);
    // 持ち主でない人は引き継げない。相手は停止していない事務長だけ。パスワードが違えば 400
    expect((await handOver(cookieOf(mgr), mgr.id, "password123")).status).toBe(403);
    expect((await handOver(oc, clerk.id, "password123")).status).toBe(409);
    expect((await handOver(oc, owner.id, "password123")).status).toBe(409);
    const wrong = await handOver(oc, mgr.id, "wrong-password");
    expect([wrong.status, (await wrong.json()).fields]).toEqual([400, ["password"]]);
    expect(auth().isOwner(owner)).toBe(true);
    // 引き継ぐと、新しい持ち主だけがクリニックを消せる・引き継げる。前の持ち主は停止できるようになる
    expect((await handOver(oc, mgr.id, "password123")).status).toBe(200);
    expect([auth().isOwner(owner), auth().isOwner(mgr), auth().ownerOf(owner.tenantId)]).toEqual([false, true, mgr.id]);
    expect(((await (await list(cookieOf(mgr))).json()) as { id: string; owner: boolean }[]).filter((x) => x.owner).map((x) => x.id)).toEqual([mgr.id]);
    expect((await handOver(oc, mgr.id, "password123")).status).toBe(403);
    expect((await suspend(cookieOf(mgr), owner.id)).status).toBe(200);
    // 監査ログの対象は相手の id だけ。auth_events には操作の名前と結果だけ。どちらにもパスワードは入らない
    const rows = instance.runAs(mgr, () => instance.getApp().audit.list()).reverse().filter((r) => r.action === "POST /api/staff/[id]/owner");
    expect(rows.map((r) => [r.target, r.result])).toEqual([
      [mgr.id, "denied"],
      [clerk.id, "rejected"],
      [owner.id, "rejected"],
      [mgr.id, "invalid"],
      [mgr.id, "ok"],
      [mgr.id, "denied"],
    ]);
    const events = auth().eventsOf(owner.tenantId).filter((e) => e.event === "tenant.owner");
    expect(events.map((e) => e.result).reverse()).toEqual(["fail", "fail", "fail", "fail", "ok", "fail"]);
    expect(JSON.stringify([rows, events])).not.toMatch(/password|wrong-password/);
  });

  it("事務長と持ち主は職員の仮のパスワードを発行でき、職員は次のログインで自分のパスワードに変えるまでほかの操作ができない（採点 r2 事務長 #4）", async () => {
    const { owner, join } = clinic("st_pw");
    const mgr = join("mgr", "manager");
    const clerk = join("clerk", "clerk");
    const old = cookieOf(clerk);
    // 事務は発行できない。持ち主でない事務長は、持ち主の分を発行できない。自分の分は発行しない
    expect((await issue(cookieOf(clerk), mgr.id)).status).toBe(403);
    expect((await issue(cookieOf(mgr), owner.id)).status).toBe(403);
    expect((await issue(cookieOf(mgr), mgr.id)).status).toBe(409);
    // 発行：値は応答で 1 回だけ。DB にはハッシュだけ。いまのセッションは切れ、前のパスワードではログインできない
    const r = await issue(cookieOf(mgr), clerk.id);
    expect(r.status).toBe(200);
    const temp = ((await r.json()) as { password: string }).password;
    expect(temp.length).toBeGreaterThanOrEqual(8);
    expect((await list(old)).status).toBe(401);
    expect(auth().login("st_pw_clerk", "password123")).toBeNull();
    const user = auth().login("st_pw_clerk", temp)!;
    expect(user.id).toBe(clerk.id);
    // 仮のパスワードのあいだは、自分のことを読むのと、パスワードを変える操作だけ
    const tc = cookieOf(user);
    const other = cookieOf(user);
    expect(((await (await me(tc)).json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    const blocked = await (await import("../../app/api/character/route")).GET(new Request("http://localhost/api/character", { headers: { cookie: tc } }));
    expect([blocked.status, ((await blocked.json()) as { password?: string }).password]).toEqual([403, "change"]);
    // 今のパスワードが違う・短い・同じは断る
    expect((await (await changeOwn(tc, "wrong-password", "newpassword1")).json()).fields).toEqual(["password"]);
    expect((await (await changeOwn(tc, temp, "short")).json()).fields).toEqual(["next"]);
    expect((await (await changeOwn(tc, temp, temp)).json()).fields).toEqual(["next"]);
    expect((await changeOwn(tc, temp, "newpassword1")).status).toBe(200);
    // 変えたら、いまのセッションは続き、ほかのセッションは切れる。仮のパスワードではもうログインできない
    expect(((await (await me(tc)).json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
    expect((await me(other)).status).toBe(401);
    expect(auth().login("st_pw_clerk", temp)).toBeNull();
    expect(auth().login("st_pw_clerk", "newpassword1")?.id).toBe(clerk.id);
    // 持ち主は、事務長の分も発行できる。自分のパスワードも変えられる
    expect((await issue(cookieOf(owner), mgr.id)).status).toBe(200);
    expect((await changeOwn(cookieOf(owner), "password123", "ownerpass99")).status).toBe(200);
    // どの記録にも、パスワードの値は残らない
    const rows = instance.runAs(owner, () => instance.getApp().audit.list()).filter((x) => x.action === "POST /api/staff/[id]/password" || x.action === "POST /api/auth/password");
    expect(rows.length).toBeGreaterThan(0);
    const events = auth().eventsOf(owner.tenantId).filter((e) => e.event === "staff.password" || e.event === "password.change");
    expect(events.map((e) => [e.event, e.result]).reverse()).toEqual([
      ["staff.password", "ok"],
      ["password.change", "fail"],
      ["password.change", "fail"],
      ["password.change", "fail"],
      ["password.change", "ok"],
      ["staff.password", "ok"],
      ["password.change", "ok"],
    ]);
    expect(JSON.stringify([rows, events])).not.toContain(temp);
    expect(JSON.stringify([rows, events])).not.toContain("newpassword1");
  });
});
