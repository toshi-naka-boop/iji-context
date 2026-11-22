// 施設の申告のルート（GET・POST /api/facility/declaration、GET /api/facility/declaration/history。design.md §15-2・§15-9 の段 17b）。実際のルートを呼ぶ。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { day } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

type Item = { key: string; row: { id: number; checkedBy: string; source: string; recheckOn: string | null } | null; status: { v: string; reason: string | null } };
type Decl = { today: string; items: Item[]; recheck: { soon: string[]; overdue: string[]; none: string[] }; mismatches: string[] };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-declaration-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("decl_owner", "やまだ", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const URL_ = "http://localhost/api/facility/declaration";
const get = (c: string | null) => new Request(URL_, { headers: c ? { cookie: c } : {} });
const post = (c: string | null, body: unknown) => new Request(URL_, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const routes = () => import("../../app/api/facility/declaration/route");
const historyRoute = () => import("../../app/api/facility/declaration/history/route");
const setRole = (u: User, role: Role) => instance.getAuth().switchRole(u, role);
const list = async (c = cookie) => (await (await (await routes()).GET(get(c))).json()) as Decl;
const save = async (body: unknown, c = cookie) => (await routes()).POST(post(c, body));
const code = (c: string, over: Record<string, unknown> = {}) => ({ item: `code:${c}`, notified: "yes", requirement: "met", startOn: "2026-09-01", notifiedOn: null, choice: null, checkedOn: day(13), recheckOn: "2027-01-13", ...over });
const itemOf = (d: Decl, key: string) => d.items.find((i) => i.key === key);

describe("施設の申告のルート", () => {
  it("未ログインは 401。読むのはどのロールも、残すのは事務長と責任者（事務・医師は 403 で何も残らない）", async () => {
    const { GET, POST } = await routes();
    expect((await GET(get(null))).status).toBe(401);
    expect((await POST(post(null, code("4102")))).status).toBe(401);
    const before = (await list()).items.find((i) => i.key === "code:4102")?.row?.id;
    for (const role of ["clerk", "doctor"] as const) {
      setRole(owner, role);
      expect([role, (await GET(get(cookie))).status]).toEqual([role, 200]);
      expect([role, (await save(code("4102"))).status]).toEqual([role, 403]);
    }
    setRole(owner, "veteran");
    expect((await save({ ...code("4102"), notified: "maybe" })).status).toBe(400);
    setRole(owner, "manager");
    expect(itemOf(await list(), "code:4102")?.row?.id).toBe(before);
  });

  it("形の違う入力は 400（知らない項目・在支病・種別で決まるコード・DX の区分なし・区分のある別コード・暦にない日・余計な欄）", async () => {
    setRole(owner, "manager");
    for (const body of [
      { ...code("4102"), item: "code:12345" },
      { ...code("4102"), item: "kyokagata" },
      code("3057"),
      code("3168"),
      code("4100"),
      code("4102", { choice: "1" }),
      code("4102", { startOn: "2026-02-30" }),
      { ...code("4102"), claimId: "K1" },
      { item: "note16", requirement: "yes", checkedOn: null, recheckOn: null },
      { item: "grade", choice: "kyokagata", requirement: "met", startOn: null, notifiedOn: null, checkedOn: null, recheckOn: null },
    ]) expect([JSON.stringify(body), (await save(body)).status]).toEqual([JSON.stringify(body), 400]);
  });

  it("残すと前の行が変更の記録に残り、確かめた人はログインした利用者。監査ログには項目の鍵だけ", async () => {
    setRole(owner, "manager");
    const res = await save(code("4102", { requirement: "not_met" }));
    expect(res.status).toBe(200);
    const d = (await res.json()) as Decl;
    expect(itemOf(d, "code:4102")).toMatchObject({ row: { checkedBy: "やまだ", source: "input" }, status: { v: "not", reason: "要件を満たさない" } });
    const h = await (await historyRoute()).GET(new Request(`${URL_}/history?item=code:4102`, { headers: { cookie } }));
    const rows = ((await h.json()) as { rows: { source: string; requirement: string }[] }).rows;
    expect(rows.map((r) => [r.source, r.requirement])).toEqual([["input", "not_met"], ["seed", "met"]]);
    expect((await (await historyRoute()).GET(new Request(`${URL_}/history?item=../x`, { headers: { cookie } }))).status).toBe(400);
    const log = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action === "POST /api/facility/declaration" && l.result === "ok");
    expect(log.map((l) => l.target)).toEqual(["code:4102"]);
  });

  it("確かめ直す日が近い（30 日以内）・過ぎた・ない申告の一覧", async () => {
    setRole(owner, "manager");
    expect((await save(code("4307", { recheckOn: day(20) }))).status).toBe(200);
    expect((await save(code("721", { recheckOn: day(1) }))).status).toBe(200);
    expect((await save({ item: "note16", requirement: "met", checkedOn: day(13), recheckOn: null })).status).toBe(200);
    // 30 日後ちょうどは「近い」、31 日後は入らない
    expect((await save({ item: "dispensing", choice: "inside", checkedOn: day(13), recheckOn: "2026-11-12" })).status).toBe(200);
    expect((await save({ item: "grade", choice: "zaishishin3", requirement: "met", startOn: "2026-09-01", notifiedOn: null, checkedOn: day(13), recheckOn: "2026-11-13" })).status).toBe(200);
    const d = await list();
    expect(d.today).toBe(day(13));
    expect(d.recheck).toEqual({ soon: ["dispensing", "code:4307"], overdue: ["code:721"], none: ["note16"] });
    // 過ぎた申告と日付のない申告は「分からない」
    expect([itemOf(d, "code:721")?.status.v, itemOf(d, "note16")?.status.v, itemOf(d, "code:4307")?.status.v]).toEqual(["unknown", "unknown", "held"]);
  });

  it("合わない組み合わせは知らせるだけ（在支診（(3)）で在宅医療充実体制加算を持つ）", async () => {
    setRole(owner, "manager");
    expect((await list()).mismatches).toEqual([]);
    expect((await save(code("4248"))).status).toBe(200);
    expect((await list()).mismatches).toEqual(["在宅医療充実体制加算を持つと申告されていますが、種別が在支診（(3)）か在支診以外です"]);
  });
});

describe("実在用のクリニック", () => {
  it("申告がなければ、種別・注16・DX・ベースアップは分からない（config の既定値を使わない）", async () => {
    const real = instance.getAuth().register("decl_real", "さとう", "password123", "real");
    const realCookie = `resemen_session=${instance.getAuth().createSession(real.id).token}`;
    const C = resolveRevision("2026-10").consts;
    const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
    const r = base.receipts[0];
    const file: UkeFile = { ...base, receipts: [{ ...r, claimId: "A1", patient: { ...r.patient, name: "架空 梅子", birth: "19480808", insurer: { number: "06139991", symbol: "77", no: "702" } }, lines: [{ kubun: C.visitKubun[0], count: 1, dates: [day(5)] }], comments: [] }] };
    const id = instance.runAs(real, () => instance.getApp().uploadUke(instance.clerkIdOf(real), writeUke(file)).flatMap((u) => u.receipts.map((x) => x.claimId)))[0];
    const f = instance.runAs(real, () => instance.getApp().caseOf(id).facility);
    expect([f.grade, f.note16Met, f.dxTier, f.baseUp]).toEqual([{ known: false }, { known: false }, { known: false }, { known: false }]);
    const d = await list(realCookie);
    expect(d.items.every((i) => i.row === null && i.status.v === "unknown")).toBe(true);
    expect(itemOf(d, "grade")?.status.reason).toBe("申告がありません");
  });
});
