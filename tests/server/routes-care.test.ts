// 介護保険・ほかの医療機関との調整の申告のルート（design.md §18-2・§18-5。v37 21b）：役割（医療事務・ベテランは入れる、事務長は見るだけ、医師は入れない）、
// zod の検査、監査ログに値・機関名・施設名を残さないこと。AI は呼ばない
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { fileOf, receiptOf } from "../helpers/care";
import { day, YM } from "../helpers/period";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;
const ID = "U1-1";

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-care-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("care_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const file = fileOf([receiptOf(1, YM, [{ kubun: "C001_1I", count: 1, dates: [day(6)] }, { kubun: "C002_2NI1", count: 1, dates: [day(6)] }])]);
  instance.runAs(owner, () => expect(instance.getApp().uploadUke(instance.clerkIdOf(owner), writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (u: string) => new Request(`http://localhost${u}`, { headers: { cookie } });
const post = (u: string, body: unknown) => new Request(`http://localhost${u}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ claimId: ID }) };
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
const basis = { checkedOn: day(3), source: "施設との契約" };
const home = { name: "架空の特養ひかり", kind: "特養（地域密着型を含む）", placedPhysician: "いいえ", mitoriFacility: "いいえ", recheckOn: day(28), ...basis };
const auditRows = () => {
  const db = new Database(instance.tenantPaths(owner.tenantId).dbFile, { readonly: true });
  try {
    return db.prepare("SELECT action, target, result FROM audit_log ORDER BY id").all() as { action: string; target: string | null; result: string }[];
  } finally {
    db.close();
  }
};

describe("申告のルート", () => {
  it("医療事務は入れられ、事務長は見るだけ、医師は見ることも入れることもできない。zod の形の違いは 400", async () => {
    const care = await import("../../app/api/patients/[claimId]/care/route");
    const homes = await import("../../app/api/care-homes/route");
    const others = await import("../../app/api/patients/[claimId]/others/route");
    const none = await import("../../app/api/patients/[claimId]/others-none/route");
    setRole("clerk");
    const h = await homes.POST(post("/api/care-homes", home));
    expect(h.status).toBe(200);
    const homeId = ((await h.json()) as { homes: { homeId: string }[] }).homes[0].homeId;
    expect((await care.POST(post(`/api/patients/${ID}/care`, { item: "residenceType", value: { type: "特養（地域密着型を含む）", careHomeId: homeId }, ...basis }), params)).status).toBe(200);
    expect((await care.POST(post(`/api/patients/${ID}/care`, { item: "residenceType", value: { type: "特養" }, ...basis }), params)).status).toBe(400);
    expect((await care.POST(post(`/api/patients/${ID}/care`, { item: "residenceType", value: { type: "自宅" }, checkedOn: day(3) }), params)).status).toBe(400);
    expect((await others.POST(post(`/api/patients/${ID}/others`, { name: "架空のあおば医院", kind: "医療機関", specialRelation: "はい", kanriSide: "当院", activities: { 医療機関が行う訪問看護: "はい" }, ...basis }), params)).status).toBe(200);
    expect((await none.POST(post(`/api/patients/${ID}/others-none`, basis), params)).status).toBe(200);
    const view = (await (await care.GET(get(`/api/patients/${ID}/care`), params)).json()) as { care: { residenceType: { value: { type: string } } }; others: unknown[]; none: unknown };
    expect([view.care.residenceType.value.type, view.others.length, view.none !== null]).toEqual(["特養（地域密着型を含む）", 1, true]);

    setRole("manager");
    expect((await care.GET(get(`/api/patients/${ID}/care`), params)).status).toBe(200);
    expect((await homes.GET(get("/api/care-homes"))).status).toBe(200);
    expect((await care.POST(post(`/api/patients/${ID}/care`, { item: "residenceType", value: { type: "自宅" }, ...basis }), params)).status).toBe(403);
    expect((await homes.POST(post("/api/care-homes", home))).status).toBe(403);
    setRole("doctor");
    expect((await care.GET(get(`/api/patients/${ID}/care`), params)).status).toBe(403);
    expect((await others.POST(post(`/api/patients/${ID}/others`, {}), params)).status).toBe(403);
    setRole("clerk");

    // 監査ログ：項目の鍵だけ。値・機関名・施設名は残さない
    const rows = auditRows().filter((r) => /care|others/.test(r.action));
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    for (const secret of ["架空の特養ひかり", "架空のあおば医院", "特養（地域密着型を含む）", "施設との契約"]) expect(text).not.toContain(secret);
  });
});
