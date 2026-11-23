// 段 19c・19d（design.md §16-4-1・16-6・16-7）：処方の日の「確かめた」の印（確かめるとき・あとから付け直す POST /api/chart/acts/rx-confirm）と、
// 医療事務が入れる訪問の時刻（POST /api/chart/structured/visit-time）。(x)：確かめたあとに印を付けると注2 が出て、処方の文が変わると印は効かなくなる。
// マスターは手で作った小さな masters.db（RESEMEN_MASTER_DIR を一時フォルダに向ける）。AI は呼ばない（SDK を差し替え、取り出しの返事を決める）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredActs } from "../../src/chart/acts";
import { resolveRevision } from "../../src/engine/revisions";
import { evaluateG11, type G11Structured } from "../../src/generic/g11";
import type { User } from "../../src/server/auth";
import { actsInput, createTorikawasure } from "../../src/server/app/torikawasure";
import { resetLimits } from "../../src/server/rate-limit";
import { rxConfirmedOf, rxHashOf } from "../../src/structured/rx-mark";
import { autoConsent } from "../helpers/consent";
import { claimId, month, YM } from "../helpers/period";
import type { SdkCall } from "../helpers/sdk";
import { GEN, smallMasters } from "../generic/small-masters";
import { C as T, tensuhyoMasters } from "../generic/small-tensuhyo";

/** 取り出しの返事：行ったことはなく、その日の処方の記載が 1 つ（vi.mock より先に用意する） */
const { RX, respond } = vi.hoisted(() => {
  const rx = "湿布を院内で";
  return {
    RX: rx,
    respond: (call: SdkCall) => {
      const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
      return props.includes("facts") ? { structured: { facts: [], acts: [], rx: [{ quote: rx }] } } : { structured: null };
    },
  };
});
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), respond));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-rx-confirm-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  process.env.RESEMEN_MASTER_DIR = path.join(tmp, "masters");
  (await import("node:fs")).mkdirSync(process.env.RESEMEN_MASTER_DIR);
  smallMasters(path.join(process.env.RESEMEN_MASTER_DIR, "masters.db")).close();
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("rx_confirm", "かくにん", "password123");
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
const app = () => instance.getApp();
const as = <T,>(fn: () => T) => instance.runAs(user, fn);

async function written() {
  resetLimits();
  const me = instance.clerkIdOf(user);
  const saved = await as(() => instance.writeChart({ user, claimId: claimId("K4"), clerkId: me, kind: "訪問診療", note: { s: "経過良好", o: "", a: "", p: "", rx: RX } }));
  return { me, saved };
}
/** 保存したカルテの日を、G11 の入力の日（rxDays）にする（B の欄と同じ道：storedDays → actsInput） */
const rxDayOf = (id: number, date: string, stored: StoredActs) => actsInput(createTorikawasure({} as never, {} as never).storedDays([{ id, date, acts: stored }])).rxDays[0];

describe("処方の日の「確かめた」の印（16-4-1。C-410・C-421）", () => {
  it("初期値のまま保存しただけでは印が付かず、「確かめた」を押すか値を選び直すと、そのときの処方の文の指紋つきで付く", async () => {
    const plain = await written();
    as(() => app().confirmActs(plain.saved.id, plain.me, { facts: [], acts: [], rx: [{ quote: RX }], rxChoice: "inside" }));
    const s0 = as(() => app().savedActs(plain.saved.id))!;
    expect(s0.rxChoice).toBe("inside");
    expect(s0.rxConfirmed).toBeNull();
    expect(rxDayOf(plain.saved.id, plain.saved.date, s0)).toEqual({ date: plain.saved.date, rx: true, choice: "inside" });

    const pressed = await written();
    as(() => app().confirmActs(pressed.saved.id, pressed.me, { facts: [], acts: [], rx: [{ quote: RX }], rxChoice: "inside", rxConfirmed: true }));
    const s1 = as(() => app().savedActs(pressed.saved.id))!;
    expect(s1.rxConfirmed).toMatchObject({ by: pressed.me, rxHash: rxHashOf([{ quote: RX }]) });
    expect(rxDayOf(pressed.saved.id, pressed.saved.date, s1).confirmed).toBe(true);

    const changed = await written();
    as(() => app().confirmActs(changed.saved.id, changed.me, { facts: [], acts: [], rx: [{ quote: RX }], rxChoice: "outside" }));
    expect(as(() => app().savedActs(changed.saved.id))!.rxConfirmed).toMatchObject({ by: changed.me });
  });

  it("(x) 確かめたあとに POST /api/chart/acts/rx-confirm で印を付けると、オーダーのない処方の日の院内が確かめられ注2 が出る。処方の文が変わると印は効かなくなる", async () => {
    const { POST } = await import("../../app/api/chart/acts/rx-confirm/route");
    const { me, saved } = await written();
    as(() => app().confirmActs(saved.id, me, { facts: [], acts: [], rx: [{ quote: RX }], rxChoice: "inside" }));
    expect((await POST(post("/api/chart/acts/rx-confirm", { noteId: String(saved.id), rxChoice: "inside", confirmed: true }))).status).toBe(200);
    const stored = as(() => app().savedActs(saved.id))!;
    expect(rxConfirmedOf(stored)).toBe(true);

    // G11：在医総管の月・院内のオーダー（14 日）・オーダーのない処方の日（カルテの日）
    const rev = resolveRevision(YM);
    const db = tensuhyoMasters();
    db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
    const d14 = `${YM}-14`;
    const S = (): G11Structured => ({
      chart: { visits: { status: "unsupported" }, orders: { status: "supported", items: [{ ref: "o1", date: d14, place: "院内", refills: null, drugs: [{ code: { system: "rece", value: "622095502" }, name: "薬", days: 14, quantity: null }] }], gaps: {} }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } },
      items: [],
      history: Array.from({ length: 12 }, (_, i) => ({ yearMonth: month(-(i + 1)), orders: { status: "supported" as const, items: [], gaps: {} }, items: [] })),
      lookbackMonths: 12,
      texts: [{ date: d14, text: "定期処方", confirmed: true }, { date: saved.date, text: `経過良好\n${RX}`, confirmed: true }],
      times: [],
    });
    const n2 = (s: StoredActs) => {
      const r = evaluateG11({ units: [{ items: [{ kind: "SI", code: T.zaiisoukan }], count: 1, days: Array.from({ length: 31 }, (_, i) => (i === 13 ? 1 : 0)) }] }, db, {
        yearMonth: YM,
        generation: GEN,
        acts: [],
        rxDays: [rxDayOf(saved.id, saved.date, s)],
        path: "uke",
        dispensing: "inside",
        declaration: { held: () => ({ v: "held" }), nameOf: () => null },
        outpatient: true,
        structured: S(),
      }, rev);
      if ("skip" in r) throw new Error(r.skip);
      return r.findings.some((f) => f.codes.includes(rev.codes.C002_N2.primary));
    };
    expect(n2(stored)).toBe(true);
    // 印を外すと「見ていません」
    expect((await POST(post("/api/chart/acts/rx-confirm", { noteId: String(saved.id), rxChoice: "inside", confirmed: false }))).status).toBe(200);
    expect(n2(as(() => app().savedActs(saved.id))!)).toBe(false);
    // 処方の文が変わったら（取り込み直し・貼り直し）、残した印はないものとして読む（消さない）
    const repasted: StoredActs = { ...stored, rx: [{ quote: "湿布を院内で（貼り直し）" }] };
    expect(repasted.rxConfirmed).not.toBeNull();
    expect(rxConfirmedOf(repasted)).toBe(false);
    expect(n2(repasted)).toBe(false);
  });

  it("確かめていないカルテは 409（付け直すのは確かめたカルテだけ）", async () => {
    const { POST } = await import("../../app/api/chart/acts/rx-confirm/route");
    const { saved } = await written();
    expect((await POST(post("/api/chart/acts/rx-confirm", { noteId: String(saved.id), rxChoice: "inside", confirmed: true }))).status).toBe(409);
  });
});

describe("医療事務が入れる訪問の時刻（16-6。POST /api/chart/structured/visit-time）", () => {
  it("診療年月の日に、終了が開始より後の時刻だけを追記で残し、出どころの印（誰・いつ）つきで読める。値は応答に返さない", async () => {
    const { POST } = await import("../../app/api/chart/structured/visit-time/route");
    const id = claimId("K4");
    const ok = await POST(post("/api/chart/structured/visit-time", { claimId: id, date: `${YM}-05`, start: "10:00", end: "11:10" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ saved: true });
    expect((await POST(post("/api/chart/structured/visit-time", { claimId: id, date: `${YM}-05`, start: "11:10", end: "10:00" }))).status).toBe(400);
    expect((await POST(post("/api/chart/structured/visit-time", { claimId: id, date: `${month(1)}-05`, start: "10:00", end: "11:10" }))).status).toBe(400);
    expect((await POST(post("/api/chart/structured/visit-time", { claimId: id, date: `${YM}-05`, start: "25:00", end: "26:10" }))).status).toBe(400);
    const times = as(() => app().visitTimesOf(app().structuredPatientOf(id), YM));
    expect(times).toEqual([{ date: `${YM}-05`, ref: null, start: "10:00", end: "11:10", by: "かくにん", at: expect.any(String) }]);
  });
});
