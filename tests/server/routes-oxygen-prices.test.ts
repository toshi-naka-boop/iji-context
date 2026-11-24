// 届け出た酸素の単価のルート（GET・POST /api/facility/oxygen-prices。design.md §19-3・§19-8）。実際のルートを呼び、監査ログを見る。AI は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-oxygen-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("oxygen_owner", "やまだ", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  // 入れるのは施設の申告と同じ役割（事務長・責任者）
  instance.getAuth().switchRole(owner, "manager");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const URL_ = "http://localhost/api/facility/oxygen-prices";
const post = (body: unknown) => new Request(URL_, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const routes = () => import("../../app/api/facility/oxygen-prices/route");
const audit = () => instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action === "POST /api/facility/oxygen-prices").reverse();

describe("酸素の単価のルート", () => {
  it("入れた・取り消したことと区分を監査ログに残す（取り消しの区分は取り消す前の行から。X-473・C-620）。単価は残さない", async () => {
    const { POST } = await routes();
    const add = await POST(post({ kind: "small", price: "1.87", validFrom: "2026-04-01", validUntil: "2027-03-31", basis: "前年の購入実績" }));
    expect(add.status).toBe(200);
    const id = ((await add.json()) as { rows: { id: number }[] }).rows[0].id;
    const revoke = await POST(post({ revokes: id }));
    expect(revoke.status).toBe(200);
    const rows = audit().filter((l) => l.result === "ok");
    expect(rows.map((l) => l.target)).toEqual(["oxygenPrice:入れた:small", "oxygenPrice:取り消し:small"]);
    expect(rows.every((l) => !String(l.target).includes("1.87") && !String(l.target).includes("187"))).toBe(true);
  });

  it("暦にない日付（13 月）は、例外ではなく 400 で断る（X-474）", async () => {
    const { POST } = await routes();
    const r = await POST(post({ kind: "small", price: "1.87", validFrom: "2026-13-01", validUntil: "2027-03-31", basis: "前年の購入実績" }));
    expect(r.status).toBe(400);
    const r2 = await POST(post({ kind: "small", price: "1.87", validFrom: "2026-02-30", validUntil: "2027-03-31", basis: "前年の購入実績" }));
    expect(r2.status).toBe(400);
  });
});
