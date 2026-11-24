// クリニックをまるごと消す（採点 r1 事務長 #8）。実際のルート（app/api/tenant/erase）を呼んで確かめる
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";

/** deleted＝消したセッション（SDK の deleteSession に渡ったもの） */
const sdk = vi.hoisted(() => ({ deleted: [] as { id: string; dir?: string }[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  deleteSession: async (id: string, o?: { dir?: string }) => void sdk.deleted.push({ id, dir: o?.dir }),
  listSessions: async () => [],
}));

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-erase-tenant-"));
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
const erase = async (cookie: string, login: string) =>
  (await import("../../app/api/tenant/erase/route")).POST(new Request("http://localhost/api/tenant/erase", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ login }) }));
/** 実在の形の UKE（同梱の見本と同じ内容は断られるので、患者を変える） */
const upload = () => {
  const f = readUke(readFileSync(path.join(repo, "fixtures", "uke", "kokuhoren.UKE")));
  return writeUke({ ...f, receipts: [{ ...f.receipts[0], patient: { ...f.receipts[0].patient, name: "架空 消子", birth: "19470707" } }] });
};

describe("クリニックをまるごと消す", () => {
  it("持ち主だけが、ログイン ID の確かめつきで消せる。DB・ファイル・アカウント・メンターのセッションが消え、ほかのクリニックは残る", async () => {
    const owner = auth().switchRole(auth().register("erase_owner", "おーなー", "password123", "real"), "manager");
    const clerk = auth().registerWithInvite("erase_clerk", "じむ", "password123", auth().createInvite(owner, "clerk").code);
    const other = auth().register("erase_other", "よそ", "password123", "real");
    instance.runAs(other, () => instance.getApp().uploadUke(instance.clerkIdOf(other), upload()));
    instance.runAs(owner, () => {
      const a = instance.getApp();
      a.uploadUke(instance.clerkIdOf(owner), upload());
      a.setSession(instance.clerkIdOf(owner), "sess-owner-1");
    });
    const dir = path.dirname(instance.tenantPaths(owner.tenantId).dbFile);
    expect(existsSync(path.join(dir, "app.db"))).toBe(true);

    // 持ち主でない人（事務長でも）は消せない。確かめの ID が違えば消さない
    expect((await erase(cookieOf(clerk), "erase_clerk")).status).toBe(403);
    const wrong = await erase(cookieOf(owner), "erase_ownr");
    expect(wrong.status).toBe(400);
    expect(existsSync(dir)).toBe(true);

    const ok = await erase(cookieOf(owner), "erase_owner");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
    // クリニックのデータはディレクトリごとない。全員がログインできず、クリニックの行もない
    expect(existsSync(dir)).toBe(false);
    expect(auth().login("erase_owner", "password123")).toBeNull();
    expect(auth().login("erase_clerk", "password123")).toBeNull();
    expect(auth().tenantKind(owner.tenantId)).toBe("undecided");
    expect(auth().tenantSize(owner.tenantId)).toBe(0);
    // メンターのセッションの記録も消した
    expect(sdk.deleted.map((d) => d.id)).toContain("sess-owner-1");
    // ログインまわりの記録は id だけ残る
    expect(auth().eventsOf(owner.tenantId).map((e) => [e.event, e.result])).toEqual(expect.arrayContaining([["tenant.erase", "ok"], ["tenant.erase", "fail"]]));
    // ほかのクリニックはそのまま
    expect(instance.runAs(other, () => instance.getApp().ukeList(instance.clerkIdOf(other))).filter((u) => u.uploaded)).toHaveLength(1);
    expect(auth().login("erase_other", "password123")?.id).toBe(other.id);
  });
});
