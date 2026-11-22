// 施設の設定のルート（GET・POST /api/facility。FR-148）。実際のルートを呼び、残した値で、取り込んだレセプトの点検（ukeCheck）の判定が変わることを確かめる。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import type { Finding } from "../../src/engine/types";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import type { UkeFile } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { claimId, day, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let owner: User;
let cookie: string;

const C = resolveRevision(YM).consts;
/** 取り込む請求：5 日に訪問診療料と往診料の両方を算定し、ベースアップ評価料の訪問診療時と再診時等を同じ日に重ねている */
const ID = "U1-1";

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-facility-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  owner = instance.getAuth().register("facility_owner", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(owner.id).token}`;
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  const r = base.receipts[0];
  const file: UkeFile = {
    ...base,
    receipts: [
      {
        ...r,
        claimId: "A1",
        patient: { ...r.patient, name: "架空 松子", birth: "19480808", insurer: { number: "06139991", symbol: "77", no: "701" } },
        lines: [
          { kubun: C.visitKubun[0], count: 1, dates: [day(5)] },
          { kubun: C.oushin.kubun, count: 1, dates: [day(5)] },
          { kubun: C.baseUp.visit[0], count: 1, dates: [day(5)] },
          { kubun: C.baseUp.revisit, count: 1, dates: [day(5)] },
        ],
        comments: [],
      },
    ],
  };
  instance.runAs(owner, () => {
    const a = instance.getApp();
    expect(a.uploadUke(instance.clerkIdOf(owner), writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([ID]);
  });
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (c: string | null) => new Request("http://localhost/api/facility", { headers: c ? { cookie: c } : {} });
const post = (c: string | null, body: unknown) => new Request("http://localhost/api/facility", { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const routes = () => import("../../app/api/facility/route");
const setRole = (role: Role) => instance.getAuth().switchRole(owner, role);
const save = async (key: string, value: unknown) => (await routes()).POST(post(cookie, { key, value }));
/** 取り込んだレセプトの点検のうち、R08 の情報不足（項目）と指摘 */
function r08() {
  const c = instance.runAs(owner, () => instance.getApp().ukeCheck(ID)) as { missing: Finding[]; findings: Finding[] };
  return {
    missing: c.missing.filter((f) => f.ruleId === "R08").map((f) => `${f.missing!.field}:${f.missing!.target}`),
    findings: c.findings.filter((f) => f.ruleId === "R08").map((f) => f.messageKey),
  };
}
const itemOf = async (key: string) => {
  const res = await (await routes()).GET(get(cookie));
  return ((await res.json()) as { items: { key: string; value: unknown; saved: boolean }[] }).items.find((i) => i.key === key);
};

describe("施設の設定のルート", () => {
  it("未ログインは 401、事務長と責任者（ベテラン）以外の役割は 403。何も残らない", async () => {
    const { GET, POST } = await routes();
    expect((await GET(get(null))).status).toBe(401);
    expect((await POST(post(null, { key: "dxTier", value: "1" }))).status).toBe(401);
    for (const role of ["clerk", "doctor"] as const) {
      setRole(role);
      expect([role, (await GET(get(cookie))).status]).toEqual([role, 403]);
      expect([role, (await save("revisitBaseUpSameDay", true)).status]).toEqual([role, 403]);
    }
    setRole("manager");
    expect(await itemOf("revisitBaseUpSameDay")).toEqual({ key: "revisitBaseUpSameDay", value: null, saved: false });
    // 責任者（ベテラン）も読めて、残す入口の権限も通る（spec FR-148「事務長・責任者」）。
    // 後のテストが監査ログの数を見るので、ここでは記録を残さない形（型違いの値で 400＝権限は通っている）で確かめる
    setRole("veteran");
    expect((await GET(get(cookie))).status).toBe(200);
    expect((await save("dxTier", "3")).status).toBe(400);
    setRole("manager");
  });

  it("項目ごとに型の違う値・知らない項目・余計な欄は 400", async () => {
    setRole("manager");
    for (const body of [
      { key: "dxTier", value: "3" },
      { key: "dxTier", value: true },
      { key: "baseUp", value: "1" },
      { key: "note16Met", value: "はい" },
      { key: "zaishishin", value: false },
      { key: "note16Met", value: true, claimId: claimId("K1") },
      { key: "note16Met" },
      // 施設の種別・注16・DX・ベースアップは施設の申告に移した（design.md §15-2）。設定の入口では受け取らない
      { key: "dxTier", value: "1" },
      { key: "baseUp", value: "通常" },
      { key: "note16Met", value: true },
      { key: "grade", value: "2" },
      { key: "priceResponse", value: "はい" },
    ]) expect([JSON.stringify(body), (await (await routes()).POST(post(cookie, body))).status]).toEqual([JSON.stringify(body), 400]);
    expect((await itemOf("priceResponse"))?.saved).toBe(false);
    expect(await itemOf("note16Met")).toBeUndefined();
  });

  it("残すと、その項目の情報不足が消えて判定が変わる。「分からない」に戻すと情報不足に戻る。監査ログには項目の名前だけ", async () => {
    setRole("clerk");
    // 既定値（config/facility.json）は不明：両方を算定した日の重ねについて、施設の設定を聞かれる（宛先は医療事務、field で見分ける）
    expect(r08()).toEqual({ missing: ["facility.revisitBaseUpSameDay:clerk"], findings: [] });
    setRole("manager");
    // 重ねて算定できない：再診時等の行を外す指摘
    expect((await save("revisitBaseUpSameDay", false)).status).toBe(200);
    expect(r08()).toEqual({ missing: [], findings: ["R08.no_revisit_on_both_day"] });
    expect(await itemOf("revisitBaseUpSameDay")).toEqual({ key: "revisitBaseUpSameDay", value: false, saved: true });
    // 重ねて算定できる：指摘なし
    expect((await save("revisitBaseUpSameDay", true)).status).toBe(200);
    expect(r08()).toEqual({ missing: [], findings: [] });
    // 「分からない」に戻す
    const back = await save("revisitBaseUpSameDay", null);
    expect(back.status).toBe(200);
    expect(((await back.json()) as { items: { key: string; value: unknown; saved: boolean }[] }).items.find((i) => i.key === "revisitBaseUpSameDay")).toEqual({ key: "revisitBaseUpSameDay", value: null, saved: true });
    expect(r08()).toEqual({ missing: ["facility.revisitBaseUpSameDay:clerk"], findings: [] });
    // 既定値が分かっている項目も「分からない」にできる（ほかの項目は既定値のまま）
    expect((await save("priceResponse", null)).status).toBe(200);
    expect(await itemOf("priceResponse")).toEqual({ key: "priceResponse", value: null, saved: true });
    expect(await itemOf("revisitPriceSameDay")).toEqual({ key: "revisitPriceSameDay", value: null, saved: false });
    expect((await save("priceResponse", true)).status).toBe(200);

    const log = instance.runAs(owner, () => instance.getApp().audit.list(500)).filter((l) => l.action === "POST /api/facility" && l.result === "ok");
    expect(log.map((l) => l.target).reverse()).toEqual(["revisitBaseUpSameDay", "revisitBaseUpSameDay", "revisitBaseUpSameDay", "priceResponse", "priceResponse"]);
  });

  it("症例ごとの上書きは、クリニックの申告より優先する（K7 は note16Met を偽に上書きしている）", async () => {
    setRole("manager");
    const decl = await import("../../app/api/facility/declaration/route");
    const note16 = (requirement: string) =>
      decl.POST(new Request("http://localhost/api/facility/declaration", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ item: "note16", requirement, checkedOn: day(13), recheckOn: "2027-01-13" }) }));
    expect((await note16("unknown")).status).toBe(200);
    const facility = (id: string) => instance.runAs(owner, () => instance.getApp().caseOf(id).facility);
    expect(facility(claimId("K7")).note16Met).toEqual({ known: true, value: false });
    expect(facility(claimId("K1")).note16Met).toEqual({ known: false });
    expect((await note16("met")).status).toBe(200);
    expect(facility(claimId("K1")).note16Met).toEqual({ known: true, value: true });
  });
});
