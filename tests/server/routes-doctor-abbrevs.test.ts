// 略語の医師への確認（spec FR-211。plan-fr211.md の受け入れ条件 3）：ルートを実際に呼んで確かめる。
// LLM は呼ばない（SDK の query を差し替える。偽の取り出しは lookup を挙げる）。マスターは手で作った小さな表（tests/chart/small-chart-masters.ts）。
// ECG12 は小さな表・本物のマスターとも名称（ＥＣＧ１２）にあって印が付かないので、その 1 行の名称を「心電図」に替えた表で「名称にない略語」として確かめる。
// B の欄（G11）を動かすため、電子点数表つきの小さな表（tests/generic/small-tensuhyo.ts）を使う（計画の受け入れ条件 1 との食い違いは報告した）
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import { ABBREV_OPTIONS, abbrevQueryErrors, MAX_ABBREV_REFS, type AbbrevRequest } from "../../src/server/app/doctor-abbrevs";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";
import { claimId, day, month, YM } from "../helpers/period";
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
  // ECG12 の行は名称を「心電図」にする（ECG12 は名称にない語になり、言い換えた「心電図」は名称と完全に一致する。X-490）
  db.prepare("UPDATE shinryo SET name = '心電図' WHERE code = '160068410'").run();
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

const refNote = (ref: string) => Number(ref.split(":")[0]);
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
    db.prepare("INSERT INTO chart_act_aliases (written_norm, tbl, code, chosen_by, chosen_at) VALUES (?, 'shinryo', ?, 'old', ?)").run("ＥＣＧ１２", LOOKUP_ROW, `${day(1)}T00:00:00.000Z`);
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
    const c = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: YM, written: "ＥＣＧ１２", lookup: "特異的ＩｇＥ半定量・定量" })}`));
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
    expect(q).toMatchObject({ yearMonth: YM, token: "ECG12", question: "この記載の『ECG12』は何を指しますか", split: false });
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
    const candidates = async (q: Record<string, string>) => {
    setRole("clerk");
    const r = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: YM, written: "ＥＣＧ１２", ...q })}`));
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
    expect(qs[0]).toMatchObject({ yearMonth: YM, split: false });
    expect(qs[0].quotes.map((x) => refNote(x.ref))).toEqual([w.id]);
    // 答えた時点で並んでいなかった記載を参照に入れた答えは 409（開き直してもらう）
    expect((await answer(qs[0], "判定不能", undefined, [`${k1Note}:act:0000000000000000`])).status).toBe(409);
  });
  it("翌月の同じ語は、別に聞かれる（クリニックごとに覚えない）", async () => {
    const { readUke, writeUke } = await import("../../src/uke/uke");
    const { readFileSync } = await import("node:fs");
    const base = readUke(readFileSync(path.join(__dirname, "..", "..", "fixtures", "uke", "shiharaikikin.UKE")));
    // 診療年月と行の日付を翌月にずらす（請求年月も 1 か月後へ）
    const next = (d: string) => (d.startsWith(`${YM}-`) ? `${month(1)}${d.slice(7)}` : d);
    const r0 = base.receipts[0];
    const file = writeUke({ ...base, billingMonth: month(2), receipts: [{ ...r0, claimId: "A1", yearMonth: month(1), lines: r0.lines.map((l) => ({ ...l, dates: l.dates.map(next) })), patient: { ...base.receipts[0].patient, name: "架空 翌月", insurer: { number: "06139991", symbol: "77", no: "801" } } }] });
    const me = instance.clerkIdOf(user);
    setRole("clerk");
    const id = instance.runAs(user, () => {
      const a = instance.getApp();
      const up = a.uploadUke(me, file).filter((u) => u.uploaded);
      const claim = up[0].receipts[0].claimId;
      const saved = a.saveRecord(claim, me, `${month(1)}-05`, { s: "", o: "ＥＣＧ１２。", a: "", p: "", rx: "" });
      a.confirmActs(saved.id, me, { facts: [], acts: [ecgAct()], rx: [], rxChoice: null });
      return saved.id;
    });
    const qs = (await list()).filter((x) => x.token === "ECG12");
    expect(qs.map((x) => [x.yearMonth, x.quotes.length])).toEqual([
      [YM, 1],
      [month(1), 1],
    ]);
    expect(refNote(qs[1].quotes[0].ref)).toBe(id);
  });
});

describe("B の欄の数の行（withAbbrev）", () => {
  it("聞く行為が 0 件のときは範囲の行を出さず、1 件以上で出す。合成カルテの確かめたあとの行為（保存していない日）は聞かない", async () => {
    const { withAbbrev } = await import("../../src/server/app/torikawasure");
    const r = { findings: [], hidden: [], unmatchedActs: [], kubunDoubts: [], handNotes: [], guide: null, ruleGuides: [], visitTimeDays: [], visitTimeRefs: {}, unmappedCodes: 0, yearMonth: YM, materialNotes: [], scope: ["もとの行"], counts: { acts: 0, unmatched: 0, notSeen: 0, hidden: {}, caution: {}, byKind: {} } };
    const marked: ChartAct = { ...ecgAct(), abbrev: ["ECG12"], match: null };
    expect(withAbbrev(r, [{ noteId: 1, acts: [{ ...ecgAct(), match: null }], stored: true }], () => "asking")).toBe(r);
    expect(withAbbrev(r, [{ noteId: 1, acts: [marked] }], () => "asking")).toBe(r);
    expect((withAbbrev(r, [{ noteId: 1, acts: [marked], stored: true }], () => "asking") as typeof r).scope).toEqual(["もとの行", "略語を医師に確かめ中 1 件（その行為は見ていません）"]);
    expect((withAbbrev(r, [{ noteId: 1, acts: [marked], stored: true }], () => "answered") as typeof r).scope).toEqual(["もとの行"]);
  });
});

describe("LLM が原文の略語を言い換えても医師確認を通る（反証 round-96 X-490）", () => {
  it("ECG12 を「心電図」と書き換えても、引用の原文で印が付き、lookup は空・名称の完全一致でも初期値に当てず、医師に聞く", async () => {
    // 比べる組：原文が「心電図」なら、名称の完全一致で初期値に当たる
    llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [{ category: "検査", written: "心電図", lookup: [], quote: "心電図" }], rx: [] }, sessionId: "", stats: {} });
    const plain = (await (await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claimId("K4"), kind: "訪問診療", note: { s: "", o: "心電図。", a: "", p: "", rx: "" } }))).json()) as Written;
    expect(plain.review.matches[0].act.initial).toMatchObject({ code: "160068410", by: "name" });
    const aliases = aliasCount();
    const w = await writeAndSave(claimId("K4"), "ＥＣＧ１２。", [{ category: "検査", written: "心電図", lookup: ["特異的ＩｇＥ半定量・定量"], quote: "ＥＣＧ１２" }]);
    expect(w.acts[0]).toMatchObject({ written: "心電図", abbrev: ["ECG12"], lookup: [] });
    expect(w.review.matches[0].act.initial).toBeNull();
    expect(w.review.matches[0].act.candidates.map((c) => c.code)).not.toContain(LOOKUP_ROW);
    expect(app().savedActs(w.id)!.acts[0]).toMatchObject({ abbrev: ["ECG12"], lookup: [], match: null });
    expect(aliasCount()).toBe(aliases);
    const q = (await list()).find((x) => x.token === "ECG12" && x.quotes.some((y) => refNote(y.ref) === w.id));
    expect(q?.quotes.find((y) => refNote(y.ref) === w.id)?.quote).toBe("ＥＣＧ１２");
  });
  it("AF を「心房細動」（傷病名の名称と完全一致）と書き換えても、引用の原文で印が付き、医師に聞く", async () => {
    const w = await writeAndSave(claimId("K1"), "変わりなし。AF。", [], [{ kind: "病名の記載", value: "心房細動", quote: "AF" }]);
    const q = (await list()).find((x) => x.token === "AF" && x.quotes.some((y) => refNote(y.ref) === w.id));
    expect(q?.quotes.find((y) => refNote(y.ref) === w.id)).toMatchObject({ ref: expect.stringContaining(":fact:"), quote: "AF" });
  });
});

describe("「違う」を選んだ行為も確かめる対象に残る（反証 round-96 X-491）", () => {
  it("当てられない行為に「違う」（same: false）を付けても、医師への問いと B の欄の確かめ中の数から消えない", async () => {
    const w = await writeAndSave(claimId("K4"), "ＴＴＥ。", [{ category: "検査", written: "ＴＴＥ", lookup: [], quote: "ＴＴＥ" }]);
    const inList = async () => (await list()).some((x) => x.token === "TTE" && x.quotes.some((y) => refNote(y.ref) === w.id));
    const scope = async () => {
      setRole("clerk");
      const r = await (await import("../../app/api/chart/[id]/claim/route")).GET(get(`/api/chart/${w.id}/claim`), { params: Promise.resolve({ id: String(w.id) }) });
      return ((await r.json()) as { torikawasure: { scope: string[] } }).torikawasure.scope.filter((x) => x.startsWith("略語を医師に確かめ中"));
    };
    expect(await inList()).toBe(true);
    const before = await scope();
    expect(before).toHaveLength(1);
    // 「違う」の印は、電子カルテの同じ種類の行為があるときに画面から付く。ここでは保存した行ったことに直接付ける
    const db = sql();
    try {
      const stored = JSON.parse((db.prepare("SELECT acts FROM chart_notes WHERE id = ?").get(w.id) as { acts: string }).acts) as { acts: ChartAct[] };
      stored.acts[0].fold = { kind: "order", by: "person", same: false };
      db.prepare("UPDATE chart_notes SET acts = ? WHERE id = ?").run(JSON.stringify(stored), w.id);
    } finally {
      db.close();
    }
    expect(await inList()).toBe(true);
    expect(await scope()).toEqual(before);
  });
});

describe("病名の記載への医師の記入の答えを、その記載を開き直したときに出す（反証 round-96 X-492）", () => {
  it("記入で答えると、確かめたカルテの一覧（GET /api/chart/acts/fixes）にその記載と「医師の答え」が出る。事実の値は書き換えず、書き方の表にも覚えない", async () => {
    const w = await writeAndSave(claimId("K1"), "著変なし。PAF。", [], [{ kind: "病名の記載", value: "PAF", quote: "PAF" }]);
    const fixes = async () => {
      setRole("clerk");
      const r = await (await import("../../app/api/chart/acts/fixes/route")).GET(get(`/api/chart/acts/fixes?claimId=${encodeURIComponent(claimId("K1"))}`));
      expect(r.status).toBe(200);
      return ((await r.json()) as { noteId: number; doctorAnswers?: unknown[] }[]).find((x) => x.noteId === w.id);
    };
    expect(await fixes()).toBeUndefined();
    const aliases = aliasCount();
    const q = (await list()).find((x) => x.token === "PAF")!;
    expect((await answer(q, "指すものを記入する", "発作性心房細動")).status).toBe(200);
    expect((await fixes())?.doctorAnswers).toEqual([{ index: 0, value: "PAF", quote: "PAF", answers: [{ token: "PAF", text: "発作性心房細動" }] }]);
    const db = sql();
    try {
      expect(JSON.parse((db.prepare("SELECT facts FROM chart_notes WHERE id = ?").get(w.id) as { facts: string }).facts)).toEqual([{ kind: "病名の記載", value: "PAF", quote: "PAF", abbrev: ["PAF"] }]);
    } finally {
      db.close();
    }
    expect(aliasCount()).toBe(aliases);
  });
});

describe("まとめの問いの引用の上限（反証 round-96 X-493）", () => {
  it("同じ月・同じ語の記載が 501 件でも、上限（GET と POST で同じ）ずつの問いに割れ、どれも画面と同じ参照で答えられる", async () => {
    expect(MAX_ABBREV_REFS).toBe(500);
    // 501 件の保存したカルテ（貼ったカルテの形）を直接入れる
    const me = instance.clerkIdOf(user);
    const db = sql();
    try {
      const act = { category: "検査", written: "ＵＣＧ", lookup: [], quote: "ＵＣＧ", match: null, abbrev: ["UCG"] };
      const acts = JSON.stringify({ acts: [act], rx: [], rxChoice: null, rxChoiceBy: null, abbrev: { marks: ["UCG"], at: `${day(1)}T00:00:00.000Z` } });
      const ins = db.prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, acts, clerk_id, created_at) VALUES (?, ?, '記録', ?, '[]', ?, ?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 501; i++) ins.run(claimId("K4"), day(1), JSON.stringify({ s: "", o: "ＵＣＧ。", a: "", p: "", rx: "" }), acts, me, `${day(1)}T00:00:00.000Z`);
      })();
    } finally {
      db.close();
    }
    const qs = (await list()).filter((x) => x.token === "UCG");
    expect(qs.map((x) => [x.split, x.quotes.length])).toEqual([
      [false, 500],
      [false, 1],
    ]);
    // 画面と同じく、並んでいる参照を全部送って答える（「記載によって違う」も通る）
    expect((await answer(qs[0], "記載によって違う")).status).toBe(200);
    const rest = (await list()).filter((x) => x.token === "UCG" && !x.split);
    expect(rest.map((x) => x.quotes.length)).toEqual([1]);
    expect((await answer(rest[0], "判定不能")).status).toBe(200);
    expect((await list()).filter((x) => x.token === "UCG" && !x.split)).toEqual([]);
    expect((await list()).filter((x) => x.token === "UCG" && x.split)).toHaveLength(500);
  });
});

describe("確かめる画面の「候補を引き直す」でも自動選択が戻らない（反証 round-97 C-630）", () => {
  it("言い換えた行為（心電図・引用 ＥＣＧ１２）は、引用を渡した引き直しで初期値に当てず、lookup も前に選んだものも使わない", async () => {
    const q = (extra: Record<string, string>) => new URLSearchParams({ table: "shinryo", ym: YM, written: "心電図", lookup: "特異的ＩｇＥ半定量・定量", ...extra });
    const get1 = async (extra: Record<string, string>) => {
      setRole("clerk");
      return (await (await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${q(extra)}`))).json()) as { initial: { code: string } | null; candidates: { code: string }[] };
    };
    // 比べる組：引用を渡さないと、名称の完全一致で初期値に当たる（引き直しが引用を渡さなかったときの抜け道）
    expect((await get1({})).initial).toMatchObject({ code: "160068410" });
    const r = await get1({ quote: "ＥＣＧ１２" });
    expect(r.initial).toBeNull();
    expect(r.candidates.map((c) => c.code)).not.toContain(LOOKUP_ROW);
  });
});
