// 反証 round-68 C-440（design.md §16-1・16-7）：画面の操作（取り込んだ請求の点検・算定プレビュー・月末の点検・カルテの確かめる画面・患者の機器の欄）で、
// 構造化データを接続先から読んで残し、G11 に渡す。GET /api/chart/structured を呼ばなくても読まれる。接続先が構造化データを返さない請求では、規則の入力を持たず、機器の欄で入力を促さない。AI は呼ばない
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import { autoConsent } from "../helpers/consent";
import { claimId, month, YM } from "../helpers/period";

/** 取り出しの返事：行ったことはなく、その日の処方の記載が 1 つ */
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) =>
  (await import("../helpers/sdk")).fakeSdk(await original<object>(), (call: import("../helpers/sdk").SdkCall) => {
    const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
    return props.includes("facts") ? { structured: { facts: [], acts: [], rx: [{ quote: "湿布を院内で" }] } } : { structured: null };
  }),
);
/** 合成の接続先のうち K1 だけが構造化データを返す形にする（同梱の structured/ のファイルを持つ K12・K13 は見本の UKE にないので、ここでは K1 で経路を確かめる） */
vi.mock("../../src/connect/fixture", async (original) => {
  const mod = await original<typeof import("../../src/connect/fixture")>();
  return {
    ...mod,
    createFixtureConnector: (root?: string) => {
      const c = mod.createFixtureConnector(root);
      return {
        ...c,
        chart: {
          async getChart(q: { patientId: string; yearMonth: string }) {
            const chart = await c.chart!.getChart(q);
            if (q.patientId !== "K1") return chart;
            const sup = <X,>(items: X[]) => ({ status: "supported" as const, items, gaps: {} });
            const now = q.yearMonth.endsWith("-10");
            const orders = now ? [{ ref: "o1", date: `${q.yearMonth}-14`, place: "院内", refills: 0, drugs: [{ code: { system: "rece", value: "622095502" }, name: "薬", days: 14, quantity: null }] }] : [];
            // 13 日（時計の初期値の日）の訪問は時刻が欠けている
            const visits = now ? [{ ref: "v13", date: `${q.yearMonth}-13`, start: null, end: null, kind: "訪問診療" }] : [];
            return { ...chart, structured: { visits: sup(visits), orders: sup(orders), procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } } };
          },
        },
      };
    },
  };
});

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-screen-load-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("screen_load", "よみこみ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
const app = () => instance.getApp();
const as = <T,>(fn: () => T) => instance.runAs(user, fn);
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { cookie } });

describe("画面の操作で構造化データを読んで残す（C-440）", () => {
  it("取り込んだ請求の点検の画面を開くと、合成の接続先から当月とさかのぼる月の処方のオーダーを読んで残し、G11 の規則の入力ができる", async () => {
    const id = claimId("K1");
    const pid = as(() => app().structuredPatientOf(id));
    expect(as(() => app().storedStructured(pid, YM))).toBeNull();
    const { GET } = await import("../../app/api/uke/claims/[claimId]/check/route");
    expect((await GET(get(`/api/uke/claims/${id}/check`), { params: Promise.resolve({ claimId: id }) })).status).toBe(200);
    const stored = as(() => app().storedStructured(pid, YM))!;
    expect(stored.chart.orders.status).toBe("supported");
    expect(stored.chart.visits.status).toBe("supported");
    // さかのぼる月（L-201）も処方のオーダーを読んで残す（読めない月にしない）
    expect(as(() => app().storedStructured(pid, month(-1)))!.chart.orders.status).toBe("supported");
    expect(as(() => app().storedStructured(pid, month(-12)))!.chart.orders.status).toBe("supported");
    expect(as(() => app().structuredRulesOf(id, YM, null))).not.toBeNull();
  });

  it("構造化データを返さない請求（structured/ のファイルがない症例）は、読んでも規則の入力を持たない。機器の欄は構造化データがないことを返す", async () => {
    const id = claimId("K2");
    const { GET } = await import("../../app/api/uke/claims/[claimId]/check/route");
    expect((await GET(get(`/api/uke/claims/${id}/check`), { params: Promise.resolve({ claimId: id }) })).status).toBe(200);
    expect(as(() => app().structuredRulesOf(id, YM, null))).toBeNull();
    const dev = await import("../../app/api/patient/devices/route");
    const body = (await (await dev.GET(get(`/api/patient/devices?claimId=${id}`))).json()) as { structured: boolean };
    expect(body.structured).toBe(false);
    const b1 = (await (await dev.GET(get(`/api/patient/devices?claimId=${claimId("K1")}`))).json()) as { structured: boolean };
    expect(b1.structured).toBe(true);
  });

  it("カルテの確かめる画面：その日の訪問の時刻が欠けていて S・O・A・P に時間の語がある日だけ、時刻の入力欄（その日の訪問の ref つき）を出す。処方の印は、在医総管の月のオーダーのない日に注2 の側で効く（C-442・C-441）", async () => {
    resetLimits();
    const me = instance.clerkIdOf(user);
    const timed = await as(() => instance.writeChart({ user, claimId: claimId("K1"), clerkId: me, kind: "訪問診療", note: { s: "診療時間 1時間10分", o: "", a: "", p: "", rx: "湿布を院内で" } }));
    expect(timed.review.visitTime).toEqual({ visits: [{ ref: "v13", kind: "訪問診療" }] });
    expect(timed.review.rxMark).toBe("n2");
    resetLimits();
    const plain = await as(() => instance.writeChart({ user, claimId: claimId("K1"), clerkId: me, kind: "訪問診療", note: { s: "経過良好", o: "", a: "", p: "", rx: "分3 毎食後" } }));
    expect(plain.review.visitTime).toBeNull();
  });

  it("処方の日の印は効く日だけ：構造化データのない在医総管の月は出さず、在医総管のない月の院内の日は調剤料・処方料の側（C-441）", async () => {
    const me = instance.clerkIdOf(user);
    resetLimits();
    const k2 = await as(() => instance.writeChart({ user, claimId: claimId("K2"), clerkId: me, kind: "訪問診療", note: { s: "経過良好", o: "", a: "", p: "", rx: "湿布を院内で" } }));
    expect(k2.review.rxMark).toBeNull();
    resetLimits();
    const k5 = await as(() => instance.writeChart({ user, claimId: claimId("K5"), clerkId: me, kind: "往診", note: { s: "経過良好", o: "", a: "", p: "", rx: "湿布を院内で" } }));
    expect(k5.review.rxMark).toBe("chozai");
  });

  it("確かめたあとで印・「同じ／違う」を付け直す一覧（GET /api/chart/acts/fixes）：印の効く日で印のない確かめたカルテを並べ、rx-confirm で印を付けると消える（C-441）", async () => {
    const me = instance.clerkIdOf(user);
    resetLimits();
    const w = await as(() => instance.writeChart({ user, claimId: claimId("K1"), clerkId: me, kind: "訪問診療", note: { s: "経過良好", o: "", a: "", p: "", rx: "湿布を院内で" } }));
    as(() => app().confirmActs(w.id, me, { facts: [], acts: [], rx: [{ quote: "湿布を院内で" }], rxChoice: "inside" }));
    const { GET } = await import("../../app/api/chart/acts/fixes/route");
    const list = async () => (await (await GET(get(`/api/chart/acts/fixes?claimId=${claimId("K1")}`))).json()) as { noteId: number; date: string; rxMark: string | null; rx: string[] }[];
    const before = await list();
    expect(before.filter((x) => x.noteId === w.id)).toEqual([expect.objectContaining({ noteId: w.id, date: w.date, rxMark: "n2", rx: ["湿布を院内で"] })]);
    as(() => app().confirmRx(w.id, me, { rxChoice: "inside", confirmed: true }));
    expect((await list()).filter((x) => x.noteId === w.id)).toEqual([]);
  });
});
