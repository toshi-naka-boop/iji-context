// 略語の辞書方式（spec FR-211。plan-fr211.md「辞書方式の決め」7 の受け入れ条件）：ルートを実際に呼んで確かめる。
// LLM は呼ばない（SDK の query を差し替える）。マスターは電子点数表つきの小さな表（tests/generic/small-tensuhyo.ts）に、略した書き方の合成カルテのコードと、
// 列の形だけをまねた作り物の万病辞書の行（AF・Af・AMI）を足す。辞書の本体は使わない
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbbrevSummary, ChartAct } from "../../src/chart/acts";
import { ABBREV_OPTIONS, abbrevQueryErrors, MAX_ABBREV_REFS, type AbbrevRequest } from "../../src/server/app/doctor-abbrevs";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
import { autoConsent } from "../helpers/consent";
import { claimId, day, YM } from "../helpers/period";
import { abbrevCodes, AF_DISEASE } from "../chart/small-chart-masters";
import { put, source } from "../generic/small-masters";
import { tensuhyoMasters } from "../generic/small-tensuhyo";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;
/** 訪問診療料（１）１の名称（名称の完全一致で初期値に当たる行） */
const VISIT = { code: "114001110", name: "在宅患者訪問診療料（１）１（同一建物居住者以外）" };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-abbrev-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  const dir = path.join(tmp, "masters");
  mkdirSync(dir);
  const db = tensuhyoMasters("20261001");
  for (const c of abbrevCodes()) if (!db.prepare(`SELECT 1 FROM ${c.tbl} WHERE snapshot = '20261001' AND code = ?`).get(c.code)) put(db, c.tbl, "20261001", c.tbl === "shinryo" ? { code: c.code, name: c.name, alpha: "*" } : { code: c.code, name: c.name });
  db.prepare("UPDATE shinryo SET name = ? WHERE snapshot = '20261001' AND code = ?").run(VISIT.name, VISIT.code);
  put(db, "shobyo", "20261001", AF_DISEASE);
  // 作り物の万病辞書の行（列の形だけ。出現形は全角のまま）
  source(db, "manbyo", "20210602");
  for (const [surface, name, reliability] of [["ＡＦ", "心房細動", "C"], ["Ａｆ", "心室細動", "C"], ["ＡＭＩ", "心臓破裂;心筋梗塞", "A"], ["ＡＤＬ", "", "F"]])
    put(db, "manbyo", "20210602", { surface, yomi: "", icd: "", name, reliability, frequency: "" });
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
const query = <T,>(q: string, ...args: unknown[]): T => {
  const db = sql();
  try {
    return db.prepare(q).all(...args) as T;
  } finally {
    db.close();
  }
};
/** 本人の処理件数を n 件にする（レベルは config/levels.json の Lv.4＝100 件、Lv.5＝180 件） */
function setCount(n: number) {
  const db = sql();
  try {
    const clerkId = instance.clerkIdOf(user);
    db.prepare("DELETE FROM questions WHERE id LIKE 'lv-%'").run();
    const ins = db.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < n; i++) ins.run(`lv-${i}`, clerkId, claimId("K1"), JSON.stringify({ id: `lv-${i}`, clerkId, claimId: claimId("K1"), phase: "完了", finishedAt: `${day(1)}T09:00:${String(i % 60).padStart(2, "0")}+09:00`, mode: "通常", correct: true, drafts: [] }));
  } finally {
    db.close();
  }
}

type Summary = Exclude<AbbrevSummary, { unseen: string }>;
type Written = { id: number; acts: ChartAct[]; facts: unknown[]; abbrev: Summary; review: { matches: { act: { initial: { code: string; by: string } | null; candidates: { code: string }[] } }[] } };
/** 訪問カルテを書く（偽の取り出し） */
async function write(claim: string, note: Partial<Record<"s" | "o" | "a" | "p" | "rx", string>>, acts: ChartAct[] = [], facts: unknown[] = []): Promise<Written> {
  llm.runOnce.mockResolvedValueOnce({ structured: { facts, acts, rx: [] }, sessionId: "", stats: {} });
  setRole("clerk");
  const r = await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claim, kind: "訪問診療", note: { s: "", o: "", a: "", p: "", rx: "", ...note } }));
  expect(r.status).toBe(200);
  return (await r.json()) as Written;
}
/** 確かめて保存する（行ったことは当てずに） */
async function confirm(w: Written, acts = w.acts) {
  setRole("clerk");
  return (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(w.id), facts: w.facts, acts: acts.map((a) => ({ ...a, match: null })), rx: [], rxChoice: null }));
}
/** 略語の扱いを選ぶ */
async function select(noteId: number, token: string, option: string, extra: { meaning?: string; askDoctor?: boolean } = {}) {
  setRole("clerk");
  return (await import("../../app/api/chart/abbrev-selections/route")).POST(post("/api/chart/abbrev-selections", { noteId: String(noteId), token, option, ...extra }));
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
const refNote = (ref: string) => Number(ref.split(":")[0]);
const tokenOf = (w: { abbrev: Summary }, t: string) => w.abbrev.tokens.find((x) => x.token === t)!;

describe("辞書の候補と、大文字小文字の別（決め 1・7）", () => {
  it("AF は万病辞書の候補（心房細動）、Af は別の意味（心室細動）。出典が添えられる。意味なしの出現形（ADL）は辞書にない略語", async () => {
    const w = await write(claimId("K4"), { a: "AF。Af。ADL低下。" });
    expect(w.abbrev.marks).toEqual(["AF", "Af", "ADL"]);
    expect(tokenOf(w, "AF")).toMatchObject({ inDict: true, candidates: [{ meaning: "心房細動", source: "万病辞書", reliability: "C" }], selection: null, doctorPending: false });
    expect(tokenOf(w, "Af").candidates.map((c) => c.meaning)).toEqual(["心室細動"]);
    expect(tokenOf(w, "ADL")).toMatchObject({ inDict: false, candidates: [] });
    expect(w.abbrev.credit?.name).toBe("CC BY 4.0");
    expect(w.abbrev.credit?.credit).toContain("万病辞書");
  });
});

describe("事務が候補から選ぶ → 医師確認（決め 2・3）", () => {
  it("Lv.4 までは、候補から選んだ意味を必ず医師確認に回す（回さないを送っても回す）。同じ月・同じ略語は患者をまたいで 1 問で、7 要件を満たし、事務の選んだ意味も患者の氏名も出さない", async () => {
    setCount(100); // Lv.4
    const a = await write(claimId("K4"), { a: "AF。" });
    const b = await write(claimId("K1"), { a: "AF。" });
    expect(a.abbrev.mustAsk).toBe(true);
    for (const w of [a, b]) {
      const r = await select(w.id, "AF", "辞書の意味", { meaning: "心房細動", askDoctor: false });
      expect(r.status).toBe(200);
      expect(tokenOf({ abbrev: (await r.json()) as Summary }, "AF")).toMatchObject({ selection: { option: "辞書の意味", meaning: "心房細動", askDoctor: true }, doctorPending: true });
    }
    const qs = (await list()).filter((x) => x.token === "AF");
    expect(qs).toHaveLength(1);
    const q = qs[0];
    expect(q).toMatchObject({ yearMonth: YM, question: "この記載の『AF』は何を指しますか", split: false });
    expect(q.options).toEqual([...ABBREV_OPTIONS]);
    expect(q.options).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(q.quotes.map((x) => [refNote(x.ref), x.quote])).toEqual(expect.arrayContaining([[a.id, "AF。"], [b.id, "AF。"]]));
    expect(abbrevQueryErrors(q)).toEqual([]);
    const text = JSON.stringify(qs);
    expect(text).not.toContain("心房細動");
    for (const p of app().patients().filter((x) => [claimId("K1"), claimId("K4")].includes(x.claimId))) expect(text).not.toContain(p.name);
    // 候補にない意味は「辞書の意味」では選べない。「その他」は意味を書き、「判定不能」は意味を付けない
    expect((await select(a.id, "AF", "辞書の意味", { meaning: "心房粗動" })).status).toBe(400);
    expect((await select(a.id, "AF", "その他")).status).toBe(400);
    expect((await select(a.id, "AF", "判定不能", { meaning: "x" })).status).toBe(400);
    expect((await select(a.id, "AF", "算定に関係なし")).status).toBe(400);
    // 片付け（ほかのテストの問いに入れない）
    expect((await answer(q, "判定不能")).status).toBe(200);
  });
  it("Lv.5 からは、医師確認に回すかを事務が選べる（回さなければ問いにならない）", async () => {
    setCount(180); // Lv.5
    const w = await write(claimId("K4"), { a: "AMI。" });
    expect(w.abbrev.mustAsk).toBe(false);
    expect(tokenOf(w, "AMI").candidates.map((c) => c.meaning)).toEqual(["心臓破裂", "心筋梗塞"]);
    const r = (await (await select(w.id, "AMI", "辞書の意味", { meaning: "心筋梗塞", askDoctor: false })).json()) as Summary;
    expect(tokenOf({ abbrev: r }, "AMI")).toMatchObject({ selection: { askDoctor: false }, doctorPending: false });
    expect((await list()).some((x) => x.token === "AMI")).toBe(false);
    const w2 = await write(claimId("K1"), { a: "AMI。" });
    await select(w2.id, "AMI", "辞書の意味", { meaning: "心筋梗塞", askDoctor: true });
    expect((await list()).find((x) => x.token === "AMI")?.quotes.map((x) => refNote(x.ref))).toEqual([w2.id]);
    setCount(0);
  });
});

describe("医師確認中でも、確定と月末の点検は止まらない（決め 3）", () => {
  it("医師確認中の札が出たまま、カルテを確定でき、算定プレビュー（B の欄を含む）も出る", async () => {
    const w = await write(claimId("K4"), { o: "Af。" });
    const s = (await (await select(w.id, "Af", "辞書の意味", { meaning: "心室細動" })).json()) as Summary;
    expect(tokenOf({ abbrev: s }, "Af").doctorPending).toBe(true);
    expect((await confirm(w)).status).toBe(200);
    setRole("clerk");
    const c = await (await import("../../app/api/chart/[id]/claim/route")).GET(get(`/api/chart/${w.id}/claim`), { params: Promise.resolve({ id: String(w.id) }) });
    expect(c.status).toBe(200);
    expect(((await c.json()) as { torikawasure?: unknown }).torikawasure).toBeDefined();
    // 片付け
    const q = (await list()).find((x) => x.token === "Af")!;
    expect((await answer(q, "判定不能")).status).toBe(200);
  });
});

describe("辞書にない略語は、そのカルテだけ自動選択と LLM の候補を止める（決め 4）", () => {
  const visitAct = (): ChartAct => ({ category: "診療行為", written: VISIT.name, lookup: ["特異的ＩｇＥ半定量・定量"], quote: VISIT.name });
  it("DOAC のあるカルテは初期値に当てず、lookup も前に選んだ対応も使わない。同じ行為を書いた別のカルテは名前で当たる", async () => {
    const held = await write(claimId("K4"), { o: `${VISIT.name}。DOAC継続。` }, [visitAct()]);
    const free = await write(claimId("K1"), { o: `${VISIT.name}。` }, [visitAct()]);
    expect(held.abbrev).toMatchObject({ hold: true, stopped: true, tokens: [{ token: "DOAC", inDict: false }] });
    expect(held.review.matches[0].act.initial).toBeNull();
    expect(held.review.matches[0].act.candidates.map((c) => c.code)).toContain(VISIT.code);
    expect(free.abbrev.marks).toEqual([]);
    expect(free.review.matches[0].act.initial).toMatchObject({ code: VISIT.code, by: "name" });
    // 候補の引き直し（カルテの位置つき）も同じ
    const cand = async (noteId: number) => {
      setRole("clerk");
      const r = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: YM, written: VISIT.name, lookup: "特異的ＩｇＥ半定量・定量", noteId: String(noteId), index: "0" })}`));
      return (await r.json()) as { initial: { code: string } | null; candidates: { code: string }[] };
    };
    expect((await cand(held.id)).initial).toBeNull();
    expect((await cand(held.id)).candidates.map((c) => c.code)).not.toContain("160056110");
    expect((await cand(free.id)).initial).toMatchObject({ code: VISIT.code });
    // 辞書にない略語は「算定に関係なし」か「医師に聞く」。辞書の扱いは選べない。選ばなくても確定できる
    expect((await select(held.id, "DOAC", "辞書の意味", { meaning: "x" })).status).toBe(400);
    expect((await confirm(held)).status).toBe(200);
    // 止めているカルテは、LLM の lookup を保存しない
    expect(app().savedActs(held.id)!.acts[0].lookup).toEqual([]);
    // 選んだ当て方は、辞書にない略語のあったカルテでは書き方の表に覚えない
    const aliases = () => query<{ n: number }[]>("SELECT COUNT(*) AS n FROM chart_act_aliases")[0].n;
    const n = aliases();
    setRole("clerk");
    const r = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(held.id), index: 0, match: { tbl: "shinryo", code: VISIT.code, name: VISIT.name, by: "candidate" } }));
    expect(r.status).toBe(200);
    expect(aliases()).toBe(n);
    // 「医師に聞く」は問いになり、「算定に関係なし」は問いにならない
    expect((await select(held.id, "DOAC", "医師に聞く")).status).toBe(200);
    expect((await list()).find((x) => x.token === "DOAC")?.quotes.map((x) => [refNote(x.ref), x.quote])).toEqual([[held.id, "DOAC継続。"]]);
    expect((await select(held.id, "DOAC", "算定に関係なし")).status).toBe(200);
    expect((await list()).some((x) => x.token === "DOAC")).toBe(false);
  });
});

describe("医師の答えで、クリニックの辞書に書き足す（決め 5）", () => {
  it("医師が辞書と違う意味を記入すると、足した人・日・元の問いつきでクリニックの辞書に足され、次のカルテから候補に出る。辞書にある意味の記入は足さない", async () => {
    const w = await write(claimId("K4"), { a: "AF。" });
    await select(w.id, "AF", "辞書の意味", { meaning: "心房細動" });
    const q = (await list()).find((x) => x.token === "AF")!;
    expect((await answer(q, "指すものを記入する", "心房粗動")).status).toBe(200);
    const rows = query<{ token: string; meaning: string; added_by: string; question: string }[]>("SELECT token, meaning, added_by, question FROM abbrev_dictionary");
    expect(rows).toEqual([{ token: "AF", meaning: "心房粗動", added_by: instance.clerkIdOf(user), question: expect.stringMatching(new RegExp(`^${YM}\\|AF\\|\\d+$`)) }]);
    expect(tokenOf(await write(claimId("K1"), { a: "AF。" }), "AF").candidates.map((c) => [c.meaning, c.source])).toEqual([
      ["心房細動", "万病辞書"],
      ["心房粗動", "クリニックの辞書"],
    ]);
    // 辞書にない略語への医師の答えも足す（辞書にある略語になる）
    const d = await write(claimId("K4"), { o: "ＮＰＰＶ装着。" });
    expect(tokenOf(d, "NPPV").inDict).toBe(false);
    await select(d.id, "NPPV", "医師に聞く");
    const q2 = (await list()).find((x) => x.token === "NPPV")!;
    expect((await answer(q2, "指すものを記入する", "非侵襲的陽圧換気")).status).toBe(200);
    expect(tokenOf(await write(claimId("K1"), { o: "ＮＰＰＶ装着。" }), "NPPV")).toMatchObject({ inDict: true, candidates: [{ meaning: "非侵襲的陽圧換気", source: "クリニックの辞書" }] });
    // 辞書にある意味の記入は足さない
    const e = await write(claimId("K4"), { a: "AF。" });
    await select(e.id, "AF", "辞書の意味", { meaning: "心房細動" });
    const q3 = (await list()).find((x) => x.token === "AF")!;
    expect((await answer(q3, "指すものを記入する", "心房細動")).status).toBe(200);
    expect(query<unknown[]>("SELECT * FROM abbrev_dictionary WHERE token = 'AF'")).toHaveLength(1);
  });
});

describe("問いの扱いと役割", () => {
  it("引用に「加算」を含む文は伏せて返る。記載によって違うで割れる。医師以外は 403、選ぶのは事務・ベテランだけ", async () => {
    const a = await write(claimId("K4"), { o: "ＭＲＩ（加算の確認）。" });
    const b = await write(claimId("K1"), { o: "ＭＲＩ施行。" });
    for (const w of [a, b]) expect((await select(w.id, "MRI", "医師に聞く")).status).toBe(200);
    const q = (await list()).find((x) => x.token === "MRI")!;
    expect(q.quotes.find((x) => refNote(x.ref) === a.id)).toMatchObject({ quote: "ＭＲＩ（＊＊の確認）。", masked: true });
    expect(abbrevQueryErrors(q)).toEqual([]);
    expect((await answer(q, "記載によって違う")).status).toBe(200);
    const split = (await list()).filter((x) => x.token === "MRI");
    expect(split.map((x) => [x.split, x.quotes.length])).toEqual([
      [true, 1],
      [true, 1],
    ]);
    expect((await answer(split[0], "記載によって違う")).status).toBe(400);
    for (const s of split) expect((await answer(s, "判定不能")).status).toBe(200);
    for (const role of ["clerk", "veteran", "manager"] as Role[]) {
      setRole(role);
      expect([role, (await (await import("../../app/api/doctor/abbrevs/route")).GET(get("/api/doctor/abbrevs"))).status]).toEqual([role, 403]);
    }
    setRole("doctor");
    expect((await (await import("../../app/api/chart/abbrev-selections/route")).POST(post("/api/chart/abbrev-selections", { noteId: String(a.id), token: "MRI", option: "医師に聞く" }))).status).toBe(403);
    // zod：語は英字の略語の形、扱いは決まったものだけ
    expect((await select(a.id, "酸素ボンベ加算", "医師に聞く")).status).toBe(400);
    expect((await select(a.id, "MRI", "覚える")).status).toBe(400);
    // このカルテにない略語は 400
    expect((await select(a.id, "AF", "医師に聞く")).status).toBe(400);
  });
  it("カルテを 1 つ消すと、そのカルテの選んだ扱い・答えの行と、記載のなくなった答えが残らない", async () => {
    const w = await write(claimId("K4"), { o: "ＨＯＴ導入。" });
    await select(w.id, "HOT", "医師に聞く");
    const q = (await list()).find((x) => x.token === "HOT")!;
    expect((await answer(q, "判定不能")).status).toBe(200);
    const count = () => query<{ s: number; i: number; a: number }[]>("SELECT (SELECT COUNT(*) FROM abbrev_selections WHERE note_id = ?) AS s, (SELECT COUNT(*) FROM abbrev_answer_items WHERE note_id = ?) AS i, (SELECT COUNT(*) FROM abbrev_answers WHERE token = 'HOT') AS a", w.id, w.id)[0];
    expect(count()).toEqual({ s: 1, i: 1, a: 1 });
    setRole("clerk");
    const d = await (await import("../../app/api/chart/[id]/route")).DELETE(new Request(`http://localhost/api/chart/${w.id}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ id: String(w.id) }) });
    expect(d.status).toBe(200);
    expect(count()).toEqual({ s: 0, i: 0, a: 0 });
  });
});

describe("まとめの問いの引用の上限（反証 round-96 X-493）", () => {
  it("同じ月・同じ語の記載が 501 件でも、上限（GET と POST で同じ）ずつの問いに割れ、どれも画面と同じ参照で答えられる", async () => {
    expect(MAX_ABBREV_REFS).toBe(500);
    const me = instance.clerkIdOf(user);
    const db = sql();
    try {
      const insNote = db.prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, acts, clerk_id, created_at) VALUES (?, ?, '記録', ?, NULL, NULL, ?, ?)");
      const insSel = db.prepare("INSERT INTO abbrev_selections (note_id, token, option, meaning, ask_doctor, chosen_by, chosen_at) VALUES (?, 'UCG', '医師に聞く', NULL, 1, ?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 501; i++) {
          const id = Number(insNote.run(claimId("K4"), day(1), JSON.stringify({ s: "", o: "ＵＣＧ。", a: "", p: "", rx: "" }), me, `${day(1)}T00:00:00.000Z`).lastInsertRowid);
          insSel.run(id, me, `${day(1)}T00:00:00.000Z`);
        }
      })();
    } finally {
      db.close();
    }
    const qs = (await list()).filter((x) => x.token === "UCG");
    expect(qs.map((x) => [x.split, x.quotes.length])).toEqual([
      [false, 500],
      [false, 1],
    ]);
    expect((await answer(qs[0], "記載によって違う")).status).toBe(200);
    const rest = (await list()).filter((x) => x.token === "UCG" && !x.split);
    expect(rest.map((x) => x.quotes.length)).toEqual([1]);
    expect((await answer(rest[0], "判定不能")).status).toBe(200);
    expect((await list()).filter((x) => x.token === "UCG" && x.split)).toHaveLength(500);
  });
});

describe("辞書で意味が複数ある略語の印（医師確認の画面の文言）", () => {
  it("大文字小文字で別の意味になる AF と、意味が 2 つある AMI の問いは multiMeaning。辞書にない略語は付かない。一覧の文は問いの応答に入らない", async () => {
    setCount(0);
    const w = await write(claimId("K4"), { a: "AF。AMI。ＴＴＥ。" });
    await select(w.id, "AF", "判定不能");
    await select(w.id, "AMI", "判定不能");
    await select(w.id, "TTE", "医師に聞く");
    const qs = await list();
    const flag = (t: string) => qs.find((x) => x.token === t)?.multiMeaning;
    expect([flag("AF"), flag("AMI"), flag("TTE")]).toEqual([true, true, false]);
    const DOCTOR_ABBREV = (await import("../../config/doctor-abbrev.json")).default;
    expect(JSON.stringify(qs)).not.toContain(DOCTOR_ABBREV.notice);
    for (const t of ["AF", "AMI", "TTE"]) expect(abbrevQueryErrors(qs.find((x) => x.token === t)!)).toEqual([]);
  });
});

describe("意味を選び終えたカルテの候補（plan-fr211.md「意味を選び終えたカルテの候補」）", () => {
  const visitAct = (): ChartAct => ({ category: "診療行為", written: VISIT.name, lookup: ["特異的ＩｇＥ半定量・定量"], quote: VISIT.name });
  const cand = async (noteId: number) => {
    setRole("clerk");
    const r = await (await import("../../app/api/chart/acts/candidates/route")).GET(get(`/api/chart/acts/candidates?${new URLSearchParams({ table: "shinryo", ym: YM, written: VISIT.name, lookup: "特異的ＩｇＥ半定量・定量", noteId: String(noteId), index: "0" })}`));
    return (await r.json()) as { initial: { code: string; by: string } | null; candidates: { code: string }[] };
  };
  it("辞書の略語だけのカルテ：選ぶ前は lookup と初期値を止め、すべての意味を選び終えたら戻る（医師確認は回る）", async () => {
    setCount(0);
    const w = await write(claimId("K4"), { o: `${VISIT.name}。`, a: "AF。AMI。" }, [visitAct()]);
    // 選ぶ前は止まる
    expect(w.abbrev).toMatchObject({ hold: false, stopped: true });
    expect(w.review.matches[0].act.initial).toBeNull();
    expect((await cand(w.id)).initial).toBeNull();
    expect((await cand(w.id)).candidates.map((c) => c.code)).not.toContain("160056110");
    // 1 つだけ選んでも、まだ止まる
    expect(((await (await select(w.id, "AF", "辞書の意味", { meaning: "心房細動" })).json()) as Summary).stopped).toBe(true);
    expect((await cand(w.id)).initial).toBeNull();
    // すべて選び終えたら、lookup と初期値が戻る
    const s = (await (await select(w.id, "AMI", "判定不能")).json()) as Summary;
    expect(s.stopped).toBe(false);
    const c = await cand(w.id);
    expect(c.initial).toMatchObject({ code: VISIT.code, by: "name" });
    expect(c.candidates.map((x) => x.code)).toContain("160056110");
    // 医師確認は今までどおり回る（Lv.4 まで）
    expect(tokenOf({ abbrev: s }, "AF").doctorPending).toBe(true);
    // 選び終えたあとに確定すると、lookup も残る
    expect((await confirm(w)).status).toBe(200);
    expect(app().savedActs(w.id)!.acts[0].lookup).toEqual(["特異的ＩｇＥ半定量・定量"]);
    for (const t of ["AF", "AMI"]) {
      const q = (await list()).find((x) => x.token === t);
      if (q) expect((await answer(q, "判定不能")).status).toBe(200);
    }
  });
  it("辞書にない略語が残るカルテは、辞書の略語の意味を選び終え、辞書にない略語の扱いを選んでも、止めたまま", async () => {
    const w = await write(claimId("K1"), { o: `${VISIT.name}。`, a: "AF。DOAC継続。" }, [visitAct()]);
    await select(w.id, "AF", "辞書の意味", { meaning: "心房細動" });
    const s = (await (await select(w.id, "DOAC", "算定に関係なし")).json()) as Summary;
    expect(s).toMatchObject({ hold: true, stopped: true });
    expect((await cand(w.id)).initial).toBeNull();
    expect((await cand(w.id)).candidates.map((x) => x.code)).not.toContain("160056110");
    const q = (await list()).find((x) => x.token === "AF");
    if (q) expect((await answer(q, "判定不能")).status).toBe(200);
  });
});
