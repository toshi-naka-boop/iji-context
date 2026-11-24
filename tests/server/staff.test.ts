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
    // 事務長が 2 人のうちは、1 人を事務にできる。最後の 1 人は事務にも停止にもできない
    expect((await setRole(mc, owner.id, "clerk")).status).toBe(200);
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
});
