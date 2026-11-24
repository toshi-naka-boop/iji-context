// 略語の医師への確認（spec FR-211。plan-fr211.md の受け入れ条件 3）：ルートを実際に呼んで確かめる。
// LLM は呼ばない（SDK の query を差し替える。偽の取り出しは lookup を挙げる）。マスターは手で作った小さな表（tests/chart/small-chart-masters.ts）。
// ECG12 は小さな表・本物のマスターとも名称（ＥＣＧ１２）にあって印が付かないので、その 1 行を除いた表で「名称にない略語」として確かめる。
// B の欄（G11）を動かすため、電子点数表つきの小さな表（tests/generic/small-tensuhyo.ts）を使う（計画の受け入れ条件 1 との食い違いは報告した）
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { abbrevCodes, AF_DISEASE } from "../chart/small-chart-masters";
import { put } from "../generic/small-masters";
import { tensuhyoMasters } from "../generic/small-tensuhyo";

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
  // 電子点数表つきの小さな表（B の欄〔G11〕が動く）に、略した書き方の合成カルテのコードを足し、ECG12 の 1 行を除く
  const db = tensuhyoMasters("20261001");
  for (const c of abbrevCodes()) if (!db.prepare(`SELECT 1 FROM ${c.tbl} WHERE snapshot = '20261001' AND code = ?`).get(c.code)) put(db, c.tbl, "20261001", c.tbl === "shinryo" ? { code: c.code, name: c.name, alpha: "*" } : { code: c.code, name: c.name });
  put(db, "shobyo", "20261001", AF_DISEASE);
  db.prepare("DELETE FROM shinryo WHERE code = '160068410'").run();
  db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
  writeFileSync(path.join(dir, "masters.db"), db.serialize());
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

describe("答えを候補と B の欄に戻す（受け入れ条件 3 の後半）", () => {
  type Claim = { torikawasure: { scope: string[]; unmatchedActs: { written: string; noteId?: number; index?: number; abbrev?: string }[] } };
  const claimOf = async (id: number): Promise<Claim> => {
    setRole("clerk");
    const r = await (await import("../../app/api/chart/[id]/claim/route")).GET(get(`/api/chart/${id}/claim`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return (await r.json()) as Claim;
  };
  const refNote = (ref: string) => Number(ref.split(":")[0]);
  const candidates = async (q: Record<string, string>) => {
    setRole("clerk");
    const r = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: "2026-10", written: "ＥＣＧ１２", ...q })}`));
    expect(r.status).toBe(200);
    return (await r.json()) as { initial: unknown; candidates: { code: string }[] };
  };
  let k4Note = 0;
  let k1Note = 0;

  it("答える前は、B の欄の当てられない行為に「確かめ中」の札が付き、範囲に「略語を医師に確かめ中 n 件」が出る", async () => {
    const q = (await list()).find((x) => x.token === "ECG12")!;
    k4Note = refNote(q.quotes.find((x) => x.claimId === claimId("K4"))!.ref);
    k1Note = refNote(q.quotes.find((x) => x.claimId === claimId("K1"))!.ref);
    const c = await claimOf(k4Note);
    expect(c.torikawasure.scope).toContain("略語を医師に確かめ中 1 件（その行為は見ていません）");
    expect(c.torikawasure.scope.some((s) => s.startsWith("医師が判定不能・その他と答えた略語"))).toBe(false);
    expect(c.torikawasure.unmatchedActs.find((u) => u.noteId === k4Note)).toMatchObject({ written: "ＥＣＧ１２", index: 0, abbrev: "asking" });
  });
  it("「記載によって違う」で 2 問に割れる。記載が 1 つの問いには「記載によって違う」を選べない", async () => {
    const q = (await list()).find((x) => x.token === "ECG12")!;
    expect((await answer(q, "記載によって違う")).status).toBe(200);
    const split = (await list()).filter((x) => x.token === "ECG12");
    expect(split.map((x) => [x.split, x.quotes.length])).toEqual([
      [true, 1],
      [true, 1],
    ]);
    expect((await answer(split[0], "記載によって違う")).status).toBe(400);
  });
  it("記入で答えると、その記載の候補に答えの語の行が入り、初期値は当たらないまま。選ぶと by が doctor になり、B の欄の数から外れる", async () => {
    const q = (await list()).find((x) => x.token === "ECG12" && refNote(x.quotes[0].ref) === k4Note)!;
    expect((await answer(q, "指すものを記入する", "特異的ＩｇＥ半定量・定量")).status).toBe(200);
    // 位置を渡さない候補（書かれた名前だけ）には、答えの語の行は入らない
    expect((await candidates({})).candidates.map((c) => c.code)).not.toContain(LOOKUP_ROW);
    // 画面の lookup に別の語を入れても使わず、医師の答えの語だけを使う
    const c = await candidates({ noteId: String(k4Note), index: "0", lookup: "使わない語" });
    expect(c.initial).toBeNull();
    expect(c.candidates.map((x) => x.code)).toContain(LOOKUP_ROW);
    const aliases = aliasCount();
    const r = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(k4Note), index: 0, match: { tbl: "shinryo", code: LOOKUP_ROW, name: "特異的ＩｇＥ半定量・定量", by: "candidate" } }));
    expect(r.status).toBe(200);
    expect(app().savedActs(k4Note)!.acts[0].match).toMatchObject({ code: LOOKUP_ROW, by: "doctor" });
    expect(aliasCount()).toBe(aliases);
    expect((await claimOf(k4Note)).torikawasure.scope.some((s) => s.includes("略語"))).toBe(false);
  });
  it("「判定不能」で答えると、B の欄の範囲に「医師が判定不能・その他と答えた略語 1 件（見ていません）」が出る", async () => {
    const q = (await list()).find((x) => x.token === "ECG12" && refNote(x.quotes[0].ref) === k1Note)!;
    expect((await answer(q, "判定不能")).status).toBe(200);
    expect((await list()).filter((x) => x.token === "ECG12")).toEqual([]);
    const c = await claimOf(k1Note);
    expect(c.torikawasure.scope).toContain("医師が判定不能・その他と答えた略語 1 件（見ていません）");
    expect(c.torikawasure.scope.some((s) => s.startsWith("略語を医師に確かめ中"))).toBe(false);
    expect(c.torikawasure.unmatchedActs.find((u) => u.noteId === k1Note)).toMatchObject({ abbrev: "unresolved" });
  });
  it("答えの後に同じ月に足した記載は新しい問いになる（前の答えを広げない）。指紋の変わった記載も新しい問い", async () => {
    const w = await writeAndSave(claimId("K4"), "ＥＣＧ１２を再検。", [ecgAct("ＥＣＧ１２を再検")]);
    const qs = (await list()).filter((x) => x.token === "ECG12");
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ yearMonth: "2026-10", split: false });
    expect(qs[0].quotes.map((x) => refNote(x.ref))).toEqual([w.id]);
    // 答えた時点で並んでいなかった記載を参照に入れた答えは 409（開き直してもらう）
    expect((await answer(qs[0], "判定不能", undefined, [`${k1Note}:act:0000000000000000`])).status).toBe(409);
  });
  it("翌月（2026-11）の同じ語は、別に聞かれる（クリニックごとに覚えない）", async () => {
    const { readUke, writeUke } = await import("../../src/uke/uke");
    const { readFileSync } = await import("node:fs");
    const base = readUke(readFileSync(path.join(__dirname, "..", "..", "fixtures", "uke", "shiharaikikin.UKE")));
    // 診療年月と行の日付を翌月にずらす（請求年月も 1 か月後へ）
    const next = (d: string) => d.replace(/^2026-10/, "2026-11");
    const r0 = base.receipts[0];
    const file = writeUke({ ...base, billingMonth: "2026-12", receipts: [{ ...r0, claimId: "A1", yearMonth: "2026-11", lines: r0.lines.map((l) => ({ ...l, dates: l.dates.map(next) })), patient: { ...base.receipts[0].patient, name: "架空 翌月", insurer: { number: "06139991", symbol: "77", no: "801" } } }] });
    const me = instance.clerkIdOf(user);
    setRole("clerk");
    const id = instance.runAs(user, () => {
      const a = instance.getApp();
      const up = a.uploadUke(me, file).filter((u) => u.uploaded);
      const claim = up[0].receipts[0].claimId;
      const saved = a.saveRecord(claim, me, "2026-11-05", { s: "", o: "ＥＣＧ１２。", a: "", p: "", rx: "" });
      a.confirmActs(saved.id, me, { facts: [], acts: [ecgAct()], rx: [], rxChoice: null });
      return saved.id;
    });
    const qs = (await list()).filter((x) => x.token === "ECG12");
    expect(qs.map((x) => [x.yearMonth, x.quotes.length])).toEqual([
      ["2026-10", 1],
      ["2026-11", 1],
    ]);
    expect(refNote(qs[1].quotes[0].ref)).toBe(id);
  });
});

describe("B の欄の数の行（withAbbrev）", () => {
  it("聞く行為が 0 件のときは範囲の行を出さず、1 件以上で出す。合成カルテの確かめたあとの行為（保存していない日）は聞かない", async () => {
    const { withAbbrev } = await import("../../src/server/app/torikawasure");
    const r = { findings: [], hidden: [], unmatchedActs: [], kubunDoubts: [], handNotes: [], guide: null, ruleGuides: [], visitTimeDays: [], visitTimeRefs: {}, unmappedCodes: 0, yearMonth: "2026-10", materialNotes: [], scope: ["もとの行"], counts: { acts: 0, unmatched: 0, notSeen: 0, hidden: {}, caution: {}, byKind: {} } };
    const marked: ChartAct = { ...ecgAct(), abbrev: ["ECG12"], match: null };
    expect(withAbbrev(r, [{ noteId: 1, acts: [{ ...ecgAct(), match: null }], stored: true }], () => "asking")).toBe(r);
    expect(withAbbrev(r, [{ noteId: 1, acts: [marked] }], () => "asking")).toBe(r);
    expect((withAbbrev(r, [{ noteId: 1, acts: [marked], stored: true }], () => "asking") as typeof r).scope).toEqual(["もとの行", "略語を医師に確かめ中 1 件（その行為は見ていません）"]);
    expect((withAbbrev(r, [{ noteId: 1, acts: [marked], stored: true }], () => "answered") as typeof r).scope).toEqual(["もとの行"]);
  });
});
