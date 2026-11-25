// 段 19b（design.md §16-2・16-3・16-7）：対応表（ext_code_maps・/api/code-maps）、確かめる画面の構造化データの欄、「同じ／違う／選ばない」（確かめるときと、あとから付け直す入口）。
// マスターは手で作った小さな masters.db（RESEMEN_MASTER_DIR を一時フォルダに向ける）。AI は呼ばない（SDK を差し替え、取り出しの返事を決める）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StructuredChart } from "../../src/connect/types";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import { autoConsent } from "../helpers/consent";
import { claimId, YM } from "../helpers/period";
import { DRUG, smallMasters } from "../generic/small-masters";
import type { SdkCall } from "../helpers/sdk";

/** 取り出しの返事：当てられない注射 1 つ（書かれた名前はマスターの名称に一致しない） */
const respond = (call: SdkCall) => {
  const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
  return props.includes("facts") ? { structured: { facts: [], acts: [{ category: "注射", written: "ひかちゅう", lookup: [], quote: "ひかちゅう" }], rx: [] } } : { structured: null };
};
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), respond));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-structured-routes-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  process.env.RESEMEN_MASTER_DIR = path.join(tmp, "masters");
  rmSync(process.env.RESEMEN_MASTER_DIR, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(process.env.RESEMEN_MASTER_DIR);
  smallMasters(path.join(process.env.RESEMEN_MASTER_DIR, "masters.db")).close();
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("structured_routes", "たいおう", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
  else process.env.RESEMEN_MASTER_DIR = before;
});
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const app = () => instance.getApp();
const as = <T,>(fn: () => T) => instance.runAs(user, fn);
const sup = <T,>(items: T[]) => ({ status: "supported" as const, items, gaps: {} });
const UNS = { status: "unsupported" as const };

describe("対応表（/api/code-maps。16-2・16-7）", () => {
  it("判定の外の独自コードを、接続先・入力欄の種類・表示名・件数で並べる（患者・日は出さない）。対応を残すと次から外れる", async () => {
    const { GET, POST } = await import("../../app/api/code-maps/route");
    const chart: StructuredChart = {
      visits: UNS,
      // 同じ接続先が、薬と処置で同じ独自コード 001 を返す
      orders: sup([{ ref: "o1", date: `${YM}-05`, place: "院内", refills: null, drugs: [{ code: { system: "local", value: "001" }, name: "独自の薬", days: 7, quantity: "7錠" }] }]),
      procedures: sup([{ ref: "p1", date: `${YM}-05`, act: { code: { system: "local", value: "001" }, name: "独自の処置", count: 1 } as never, count: 1, items: [] }]),
      homeCare: sup([{ ref: "h1", kind: { code: null, name: null }, devices: [{ code: { system: "local", value: "D01" }, name: "独自の機器", startedOn: null, endedOn: null }], startedOn: null }]),
    };
    as(() => app().saveStructured(app().structuredPatientOf(claimId("K1")), YM, "fixture", chart));
    const list = (await (await GET(get("/api/code-maps"))).json()) as { field: string; extCode: string; names: string[]; count: number }[];
    expect(list.map((x) => [x.field, x.extCode, x.names, x.count])).toEqual([
      ["機器", "D01", ["独自の機器"], 1],
      ["薬", "001", ["独自の薬"], 1],
      ["行為", "001", ["独自の処置"], 1],
    ].sort((a, b) => (`fixture${a[0]}${a[1]}` < `fixture${b[0]}${b[1]}` ? -1 : 1)));
    expect(JSON.stringify(list)).not.toMatch(/P\d{4}|K1|2026-\d\d-\d\d/);

    // 欄の種類ごとに別に残り、互いを上書きしない
    expect((await POST(post("/api/code-maps", { connectorId: "fixture", field: "薬", extCode: "001", code: DRUG, yearMonth: YM }))).status).toBe(200);
    const visit = (await import("../../src/engine/revisions/r2026")).r2026.codes.C001_1I.primary;
    expect((await POST(post("/api/code-maps", { connectorId: "fixture", field: "行為", extCode: "001", code: visit, yearMonth: YM }))).status).toBe(200);
    // 行為の欄に医薬品コードの対応は 400
    expect((await POST(post("/api/code-maps", { connectorId: "fixture", field: "行為", extCode: "001", code: DRUG, yearMonth: YM }))).status).toBe(400);
    // 機器の欄：DEVICE_KINDS にないキー・マスターのコードは 400、キーなら残せる
    for (const code of ["none", "C999", "114006210"]) expect([code, (await POST(post("/api/code-maps", { connectorId: "fixture", field: "機器", extCode: "D01", code, yearMonth: YM }))).status]).toEqual([code, 400]);
    expect((await POST(post("/api/code-maps", { connectorId: "fixture", field: "機器", extCode: "D01", code: "C158", yearMonth: YM }))).status).toBe(200);
    expect(await (await GET(get("/api/code-maps"))).json()).toEqual([]);
    // 薬の対応と行為の対応は別の行（行為を残しても、薬は医薬品のまま）
    const rows = as(() => app().structuredItemsOf(claimId("K1"), YM, null));
    expect(rows).not.toBeNull();
    const { withMasters } = await import("../../src/masters/db");
    const items = as(() => withMasters((db) => app().structuredItemsOf(claimId("K1"), YM, db)!.items));
    expect(items.map((x) => [x.kind, x.code, x.tbl])).toEqual([
      ["drug", DRUG, "iyakuhin"],
      ["proc", visit, "shinryo"],
    ]);
  });
});

describe("確かめる画面の構造化データの欄と「同じ／違う／選ばない」（16-3）", () => {
  const INJ_REF = "p9";
  async function written() {
    resetLimits();
    const me = instance.clerkIdOf(user);
    const id = claimId("K4");
    const saved = await as(() => instance.writeChart({ user, claimId: id, clerkId: me, kind: "訪問診療", note: { s: "ひかちゅう", o: "", a: "", p: "", rx: "" } }));
    as(() =>
      app().saveStructured(app().structuredPatientOf(id), YM, "fixture", {
        visits: UNS,
        orders: UNS,
        procedures: sup([{ ref: INJ_REF, date: saved.date, act: { code: { system: "rece", value: (instanceCodes.visit) }, name: "電子カルテの注射" }, count: 1, items: [] }]),
        homeCare: UNS,
      }),
    );
    return { me, saved, review: as(() => app().actsReviewOf(saved.id, saved.acts, saved.rx)) };
  }
  const instanceCodes = { visit: "" };
  beforeAll(async () => {
    instanceCodes.visit = (await import("../../src/engine/revisions/r2026")).r2026.codes.C001_1I.primary;
  });

  it("当てられない行為の横に、その日の同じ種類の電子カルテの行為を並べる（初期値なし）。選ばなくても保存できる", async () => {
    const { me, saved, review } = await written();
    expect(review.structured?.day.map((x) => x.ref)).toEqual([INJ_REF]);
    expect(review.structured?.acts).toEqual([{ status: "unmatched", pairs: [expect.objectContaining({ ref: INJ_REF, name: "電子カルテの注射" })] }]);
    expect(as(() => app().confirmActs(saved.id, me, { facts: [], acts: saved.acts.map((a) => ({ ...a, match: null })), rx: [], rxChoice: null }))).toMatchObject({ claimId: claimId("K4") });
    expect(as(() => app().savedActs(saved.id))!.acts[0].fold).toBeUndefined();
  });

  it("「同じ」を選んで保存すると印が残る。その日の電子カルテにない ref は 400。あとから「違う」「選ばない」に付け直せる（POST /api/chart/acts/fold）", async () => {
    const { POST } = await import("../../app/api/chart/acts/fold/route");
    const { me, saved } = await written();
    expect(() => as(() => app().confirmActs(saved.id, me, { facts: [], acts: saved.acts.map((a) => ({ ...a, match: null, fold: { kind: "order", ref: "ない行", by: "person" } })), rx: [], rxChoice: null }))).toThrow(/その日の同じ種類/);
    as(() => app().confirmActs(saved.id, me, { facts: [], acts: saved.acts.map((a) => ({ ...a, match: null, fold: { kind: "order", ref: INJ_REF, by: "person" } })), rx: [], rxChoice: null }));
    expect(as(() => app().savedActs(saved.id))!.acts[0].fold).toEqual({ kind: "order", ref: INJ_REF, by: "person" });
    expect((await POST(post("/api/chart/acts/fold", { noteId: String(saved.id), index: 0, choice: "different" }))).status).toBe(200);
    expect(as(() => app().savedActs(saved.id))!.acts[0].fold).toEqual({ kind: "order", by: "person", same: false });
    expect((await POST(post("/api/chart/acts/fold", { noteId: String(saved.id), index: 0, choice: "none" }))).status).toBe(200);
    expect(as(() => app().savedActs(saved.id))!.acts[0].fold).toBeUndefined();
    expect((await POST(post("/api/chart/acts/fold", { noteId: String(saved.id), index: 0, choice: "same", ref: "ない行" }))).status).toBe(400);
    expect((await POST(post("/api/chart/acts/fold", { noteId: String(saved.id), index: 0, choice: "same", ref: INJ_REF }))).status).toBe(200);
  });
});
