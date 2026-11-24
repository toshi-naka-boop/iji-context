// 略語の医師への確認（spec FR-211。plan-fr211.md の受け入れ条件 3）：ルートを実際に呼んで確かめる。
// LLM は呼ばない（SDK の query を差し替える。偽の取り出しは lookup を挙げる）。マスターは手で作った小さな表（tests/chart/small-chart-masters.ts）。
// ECG12 は小さな表・本物のマスターとも名称（ＥＣＧ１２）にあって印が付かないので、その 1 行を除いた表で「名称にない略語」として確かめる（計画の受け入れ条件 1 との食い違いは報告した）
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import { ABBREV_OPTIONS, abbrevQueryErrors, type AbbrevRequest } from "../../src/server/app/doctor-abbrevs";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";
import { claimId } from "../helpers/period";
import { chartMasters } from "../chart/small-chart-masters";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-abbrev-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  const dir = path.join(tmp, "masters");
  mkdirSync(dir);
  const db = chartMasters(path.join(dir, "masters.db"));
  db.prepare("DELETE FROM shinryo WHERE code = '160068410'").run();
  db.close();
  process.env.RESEMEN_MASTER_DIR = dir;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("abbrev_owner", "かるて", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
  else process.env.RESEMEN_MASTER_DIR = before;
});
beforeEach(() => {
  resetLimits();
  llm.runOnce.mockReset();
  setRole("clerk");
});

const get = (url: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const setRole = (role: Role) => instance.getAuth().switchRole(user, role);
const app = () => instance.runAs(user, () => instance.getApp());
/** クリニックの app.db（先に開いて表を作ってから読む） */
const sql = () => (app(), new Database(instance.tenantPaths(user.tenantId).dbFile));
const aliasCount = () => {
  const db = sql();
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM chart_act_aliases").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

/** 名称にある行（特異的ＩｇＥ半定量・定量）を lookup に挙げる偽の取り出し。lookup を止めないと、その行が候補に出る */
const LOOKUP_ROW = "160056110";
const ecgAct = (quote = "ＥＣＧ１２"): ChartAct => ({ category: "検査", written: "ＥＣＧ１２", lookup: ["特異的ＩｇＥ半定量・定量"], quote });
type Written = { id: number; acts: ChartAct[]; abbrev: { marks: string[]; asked: number } | { unseen: string }; review: { matches: { act: { initial: unknown; candidates: { code: string; prior: boolean }[] } }[] } };

/** 訪問カルテを書いて（偽の取り出し）、行為を当てずに確かめて保存する */
async function writeAndSave(claim: string, o: string, acts: ChartAct[], facts: unknown[] = []): Promise<Written> {
  llm.runOnce.mockResolvedValueOnce({ structured: { facts, acts, rx: [] }, sessionId: "", stats: {} });
  const r = await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claim, kind: "訪問診療", note: { s: "", o, a: "", p: "", rx: "" } }));
  expect(r.status).toBe(200);
  const w = (await r.json()) as Written;
  // 画面から来た lookup・印はそのまま送り返す（サーバーが付け直す）
  const s = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(w.id), facts: (w as unknown as { facts: unknown[] }).facts, acts: acts.map((a) => ({ ...a, match: null, abbrev: ["使わない"] })), rx: [], rxChoice: null }));
  expect(s.status).toBe(200);
  return w;
}
async function list(): Promise<AbbrevRequest[]> {
  setRole("doctor");
  const r = await (await import("../../app/api/doctor/abbrevs/route")).GET(get("/api/doctor/abbrevs"));
  expect(r.status).toBe(200);
  return (await r.json()) as AbbrevRequest[];
}
async function answer(q: AbbrevRequest, option: string, freeText?: string, refs = q.quotes.map((x) => x.ref)) {
  setRole("doctor");
  return (await import("../../app/api/doctor/abbrevs/route")).POST(post("/api/doctor/abbrevs", { yearMonth: q.yearMonth, token: q.token, refs, option, ...(freeText !== undefined ? { freeText } : {}) }));
}

describe("印・lookup・書き方の表（受け入れ条件 3 の前半）", () => {
  const notes: number[] = [];
  it("前に覚えた書き方があっても、印のある書き方では読まない。偽の LLM が lookup を挙げても、返す行為・保存した行為の lookup は空で、候補に lookup 由来の行がない", async () => {
    const db = sql();
    db.prepare("INSERT INTO chart_act_aliases (written_norm, tbl, code, chosen_by, chosen_at) VALUES (?, 'shinryo', ?, 'old', '2026-10-01T00:00:00.000Z')").run("ＥＣＧ１２", LOOKUP_ROW);
    db.close();
    const aliases = aliasCount();
    for (const k of ["K4", "K1"]) {
      const w = await writeAndSave(claimId(k), "ＥＣＧ１２。", [ecgAct()]);
      notes.push(w.id);
      expect(w.acts[0]).toMatchObject({ abbrev: ["ECG12"], lookup: [] });
      expect(w.abbrev).toEqual({ marks: ["ECG12"], asked: 1 });
      expect(w.review.matches[0].act.initial).toBeNull();
      expect(w.review.matches[0].act.candidates.map((c) => c.code)).not.toContain(LOOKUP_ROW);
      const saved = app().savedActs(w.id)!;
      expect(saved.acts[0]).toMatchObject({ written: "ＥＣＧ１２", lookup: [], abbrev: ["ECG12"], match: null });
      expect(saved.abbrev).toMatchObject({ marks: ["ECG12"] });
    }
    // 候補の入口（GET /api/chart/acts/candidates）も、印のある書き方には lookup と前に選んだものを使わない
    const c = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: "2026-10", written: "ＥＣＧ１２", lookup: "特異的ＩｇＥ半定量・定量" })}`));
    expect(((await c.json()) as { candidates: { code: string }[] }).candidates.map((x) => x.code)).not.toContain(LOOKUP_ROW);
    expect(aliasCount()).toBe(aliases);
  });
  it("医療事務が自分で探して当てた印のある行為は、問いから外れ、書き方の表に覚えない", async () => {
    const aliases = aliasCount();
    llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [ecgAct()], rx: [] }, sessionId: "", stats: {} });
    const w = (await (await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claimId("K4"), kind: "訪問診療", note: { s: "", o: "ＥＣＧ１２。", a: "", p: "", rx: "" } }))).json()) as Written;
    const s = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(w.id), facts: [], acts: [{ ...ecgAct(), match: { tbl: "shinryo", code: LOOKUP_ROW, name: "特異的ＩｇＥ半定量・定量", by: "search" } }], rx: [], rxChoice: null }));
    expect(s.status).toBe(200);
    expect(aliasCount()).toBe(aliases);
    expect((await list()).flatMap((q) => q.quotes.map((x) => x.ref))).not.toContain(expect.stringMatching(new RegExp(`^${w.id}:`)));
  });
  it("医師の一覧：2 つの請求の ECG12 が 1 問・引用 2 件。選択肢はちょうど 4 つ（その他・判定不能を含む）。定型文と選択肢が validateQuery に掛からない。患者の氏名がない", async () => {
    const qs = await list();
    expect(qs).toHaveLength(1);
    const q = qs[0];
    expect(q).toMatchObject({ yearMonth: "2026-10", token: "ECG12", question: "この記載の『ECG12』は何を指しますか", split: false });
    expect(q.quotes.map((x) => x.claimId).sort()).toEqual([claimId("K1"), claimId("K4")].sort());
    expect(q.quotes.every((x) => x.quote === "ＥＣＧ１２" && x.date.length === 10)).toBe(true);
    expect(q.options).toEqual([...ABBREV_OPTIONS]);
    expect(q.options).toHaveLength(4);
    expect(q.options).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(abbrevQueryErrors(q)).toEqual([]);
    const text = JSON.stringify(qs);
    for (const p of app().patients().filter((x) => x.claimId === claimId("K1") || x.claimId === claimId("K4"))) expect(text).not.toContain(p.name);
  });
  it("引用に「加算」を含む文は伏せて返る。医師以外の役割は 403", async () => {
    const w = await writeAndSave(claimId("K4"), "ＭＲＩ（加算の確認）。", [{ category: "検査", written: "ＭＲＩ", lookup: [], quote: "ＭＲＩ（加算の確認）" }]);
    const q = (await list()).find((x) => x.token === "MRI")!;
    expect(q.quotes).toEqual([expect.objectContaining({ quote: "ＭＲＩ（＊＊の確認）", masked: true })]);
    expect(abbrevQueryErrors(q)).toEqual([]);
    for (const role of ["clerk", "veteran", "manager"] as Role[]) {
      setRole(role);
      expect([role, (await (await import("../../app/api/doctor/abbrevs/route")).GET(get("/api/doctor/abbrevs"))).status]).toEqual([role, 403]);
      const r = await (await import("../../app/api/doctor/abbrevs/route")).POST(post("/api/doctor/abbrevs", { yearMonth: q.yearMonth, token: q.token, refs: q.quotes.map((x) => x.ref), option: "判定不能" }));
      expect([role, r.status]).toEqual([role, 403]);
    }
    // 片付け（ほかのテストの問いの数に入れない）
    expect((await answer(q, "判定不能")).status).toBe(200);
    expect((await list()).some((x) => x.token === "MRI" && x.quotes.some((y) => y.ref.startsWith(`${w.id}:`)))).toBe(false);
    // カルテを 1 つ消すと、その記載の行と、記載のなくなった答えが残らない
    const count = () => {
      const db = sql();
      try {
        return db.prepare("SELECT (SELECT COUNT(*) FROM abbrev_answer_items WHERE note_id = ?) AS items, (SELECT COUNT(*) FROM abbrev_answers WHERE token = 'MRI') AS answers").get(w.id);
      } finally {
        db.close();
      }
    };
    expect(count()).toEqual({ items: 1, answers: 1 });
    setRole("clerk");
    const d = await (await import("../../app/api/chart/[id]/route")).DELETE(new Request(`http://localhost/api/chart/${w.id}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ id: String(w.id) }) });
    expect(d.status).toBe(200);
    expect(count()).toEqual({ items: 0, answers: 0 });
  });
});
