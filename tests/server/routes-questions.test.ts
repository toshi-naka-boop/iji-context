// 処理体験（1 件＝1 問）のルート。実際のルート（app/api/questions/**/route.ts）を呼んで、ログイン・入力の検証・所有・監査ログを確かめる
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaimContext } from "../../src/engine/types";
import type { Question } from "../../src/practice/practice";
import type { User } from "../../src/server/auth";
import { claimId, day, YM } from "../helpers/period";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-questions-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  user = instance.getAuth().register("clinic_questions", "やまだ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const CLAIM = claimId("K1");
const get = (url: string, c: string | null = cookie) => new Request(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
const post = (url: string, body?: unknown, c: string | null = cookie) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(c ? { cookie: c } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const auditRows = () => instance.runAs(user, () => instance.getApp().audit.list(500));
/** 同じクリニックのほかの人（ベテラン役）の問題 */
const othersQuestion = () => instance.runAs(user, () => instance.getApp().start("vet1", CLAIM));

const start = async (body: unknown, c: string | null = cookie) => (await import("../../app/api/questions/route")).POST(post("/api/questions", body, c));
const one = async (id: string, c: string | null = cookie) => (await import("../../app/api/questions/[id]/route")).GET(get(`/api/questions/${id}`, c), params(id));
const caseOf = async (id: string) => (await import("../../app/api/questions/[id]/case/route")).GET(get(`/api/questions/${id}/case`), params(id));
const drill = async (id: string) => (await import("../../app/api/questions/[id]/drill/route")).GET(get(`/api/questions/${id}/drill`), params(id));
const choices = async (id: string) => (await import("../../app/api/questions/[id]/choices/route")).GET(get(`/api/questions/${id}/choices`), params(id));
const pick = async (id: string, body: unknown) => (await import("../../app/api/questions/[id]/choices/route")).POST(post(`/api/questions/${id}/choices`, body), params(id));
const draft = async (id: string, body: unknown, c: string | null = cookie) => (await import("../../app/api/questions/[id]/draft/route")).POST(post(`/api/questions/${id}/draft`, body, c), params(id));
const confirm = async (id: string, body: unknown) => (await import("../../app/api/questions/[id]/confirm/route")).POST(post(`/api/questions/${id}/confirm`, body), params(id));
const explain = async (id: string) => (await import("../../app/api/questions/[id]/explain/route")).POST(post(`/api/questions/${id}/explain`, {}), params(id));
const done = async (id: string) => (await import("../../app/api/questions/[id]/done/route")).POST(post(`/api/questions/${id}/done`, {}), params(id));
const localRules = async (id: string, body: unknown) => (await import("../../app/api/questions/[id]/local-rules/route")).POST(post(`/api/questions/${id}/local-rules`, body), params(id));

describe("ログイン", () => {
  it("未ログインは 401（処理に入らない）", async () => {
    expect((await start({ claimId: CLAIM }, null)).status).toBe(401);
    expect((await one("q0001", null)).status).toBe(401);
    expect((await draft("q0001", { lines: [] }, null)).status).toBe(401);
  });
});

describe("問題の進行（画面が送る形のまま）", () => {
  it("始める → 下書き → 確定 → 解説 → 完了。段階を飛ばすと 409 と文言。GET 以外は監査ログに 1 行ずつ残る", async () => {
    const before = auditRows().length;
    // 画面は claimId・mode と、あれば asOf・drill を送る
    const started = await start({ claimId: CLAIM, mode: "通常" });
    expect(started.status).toBe(200);
    const q = (await started.json()) as Question;
    expect(q).toMatchObject({ clerkId: instance.clerkIdOf(user), claimId: CLAIM, phase: "ヒント", mode: "通常" });
    expect(q.id).toMatch(/^q\d{4}$/);
    expect(await (await one(q.id)).json()).toMatchObject({ id: q.id, phase: "ヒント" });

    // 始まりの請求の明細を、そのまま送り返せる（画面はこの明細を編集して送る）
    const c = (await (await caseOf(q.id)).json()) as ClaimContext;
    expect(c.claimId).toBe(CLAIM);
    expect(c.lines.length).toBeGreaterThan(0);
    expect(await (await drill(q.id)).json()).toBeNull();
    expect((await localRules(q.id, { lines: c.lines })).status).toBe(200);

    // 確定の前に解説へは進めない
    const early = await explain(q.id);
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe("解説に進めない段階: ヒント");

    const d = await draft(q.id, { lines: c.lines });
    expect(d.status).toBe(200);
    expect(((await d.json()) as { question: Question }).question.drafts).toHaveLength(1);
    const confirmed = await confirm(q.id, { lines: c.lines });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ phase: "判定", correct: true });
    // 確定は 1 回だけ
    const twice = await confirm(q.id, { lines: c.lines });
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("確定できない段階: 判定");
    expect(await (await explain(q.id)).json()).toMatchObject({ phase: "解説" });
    const finished = await done(q.id);
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ phase: "完了" });

    // GET と、読み取り相当の POST（当てはまるローカルルール）は残らない。対象は、始めるときは請求の id、それ以外は問題の id
    expect(auditRows().slice(0, auditRows().length - before).reverse().map((r) => [r.action, r.target, r.result])).toEqual([
      ["POST /api/questions", CLAIM, "ok"],
      ["POST /api/questions/[id]/explain", q.id, "rejected"],
      ["POST /api/questions/[id]/draft", q.id, "ok"],
      ["POST /api/questions/[id]/confirm", q.id, "ok"],
      ["POST /api/questions/[id]/confirm", q.id, "rejected"],
      ["POST /api/questions/[id]/explain", q.id, "ok"],
      ["POST /api/questions/[id]/done", q.id, "ok"],
    ]);
  });

  it("練習問題と、訪問の時点の問題を始められる。ない練習問題・ない訪問日は 404", async () => {
    const drilled = await start({ claimId: CLAIM, mode: "通常", drill: "d01" });
    expect(drilled.status).toBe(200);
    const q = (await drilled.json()) as Question;
    expect(q.drill).toBe("d01");
    expect(await (await drill(q.id)).json()).toEqual({ kind: "明細" });
    expect(auditRows()[0]).toMatchObject({ action: "POST /api/questions", target: "d01", result: "ok" });
    const noDrill = await start({ claimId: CLAIM, drill: "d99" });
    expect(noDrill.status).toBe(404);
    expect((await noDrill.json()).error).toBe("練習問題がない: d99");

    const visitDay = instance.runAs(user, () => instance.getApp().visits(instance.clerkIdOf(user)).find((v) => v.claimId === CLAIM)!.date);
    const visit = await start({ claimId: CLAIM, mode: "通常", asOf: visitDay });
    expect(visit.status).toBe(200);
    expect(((await visit.json()) as Question).asOf).toBe(visitDay);
    expect((await start({ claimId: CLAIM, mode: "通常", asOf: day(3) })).status).toBe(404);
    expect((await start({ claimId: CLAIM, mode: "選択", asOf: visitDay })).status).toBe(400);
    expect((await start({ claimId: claimId("K99") })).status).toBe(404);
  });

  it("選択モード：一覧を取り、選ぶ。選択肢にないものは 400、通常モードの問題では 400", async () => {
    const q = (await (await start({ claimId: CLAIM, mode: "選択" })).json()) as Question;
    const items = (await (await choices(q.id)).json()) as { lineIndex: number; options: string[] }[];
    expect(items.length).toBeGreaterThan(0);
    const picked = await pick(q.id, { lineIndex: items[0].lineIndex, option: "判定不能" });
    expect(picked.status).toBe(200);
    expect(await picked.json()).toEqual({ correct: false, findings: [] });
    const bad = await pick(q.id, { lineIndex: items[0].lineIndex, option: "ZZZ" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("選択肢にない: ZZZ");
    expect((await pick(q.id, { lineIndex: 99, option: "判定不能" })).status).toBe(400);
    const normal = (await (await start({ claimId: CLAIM })).json()) as Question;
    expect((await choices(normal.id)).status).toBe(400);
  });
});

describe("入力の検証", () => {
  it("スキーマに合わない入力は 400 と項目名", async () => {
    const fields = async (r: Response) => {
      expect(r.status).toBe(400);
      return ((await r.json()) as { fields: string[] }).fields;
    };
    // 始める：請求の id の形、知らない項目、モード、日付、練習問題の id
    expect(await fields(await start({ claimId: "../K1" }))).toEqual(["claimId"]);
    expect(await fields(await start({ claimId: CLAIM, clerkId: "vet1" }))).toEqual(["clerkId"]);
    expect(await fields(await start({ claimId: CLAIM, mode: "速習" }))).toEqual(["mode"]);
    expect(await fields(await start({ claimId: CLAIM, asOf: "3/12" }))).toEqual(["asOf"]);
    expect(await fields(await start({ claimId: CLAIM, drill: "d1; DROP" }))).toEqual(["drill"]);

    const q = (await (await start({ claimId: CLAIM })).json()) as Question;
    // 問題の id の形でないものは、探す前に断る
    expect(await fields(await one("../../auth"))).toEqual(["id"]);
    // 明細：行の形、知らない項目（事実は画面から受け取らない）、件数の上限
    expect(await fields(await draft(q.id, {}))).toEqual(["lines"]);
    expect(await fields(await draft(q.id, { lines: [{ kubun: "c001 1i", count: 1, dates: [day(14)] }] }))).toEqual(["lines.0.kubun"]);
    expect(await fields(await confirm(q.id, { lines: [{ kubun: "C001_1I", count: 1.5, dates: [`${YM}-abc`] }] }))).toEqual(["lines.0.count", "lines.0.dates.0"]);
    expect(await fields(await confirm(q.id, { lines: [], facts: { careLevel: { known: true, value: 5 } } }))).toEqual(["facts"]);
    expect(await fields(await localRules(q.id, { lines: Array.from({ length: 101 }, () => ({ kubun: "C001_1I", count: 1, dates: [] })) }))).toEqual(["lines"]);
    expect(await fields(await pick(q.id, { lineIndex: -1, option: "" }))).toEqual(["lineIndex", "option"]);
    // 断った入力では、問題は進んでいない
    expect(await (await one(q.id)).json()).toMatchObject({ phase: "ヒント", drafts: [], confirmed: null });
    expect(auditRows()[0]).toMatchObject({ action: "POST /api/questions/[id]/choices", target: q.id, result: "invalid", status: 400 });
  });
});

describe("明細の区分", () => {
  it("形は合っているが点数表にない区分は、判定に渡す前に 400 と文言で断る（定型文の 500 にしない）", async () => {
    const q = (await (await start({ claimId: CLAIM })).json()) as Question;
    const lines = [{ kubun: "ZZZ_9", count: 1, dates: [day(12)] }];
    for (const r of [await draft(q.id, { lines }), await confirm(q.id, { lines }), await localRules(q.id, { lines })]) {
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("未知の区分: ZZZ_9");
    }
    expect(((await (await one(q.id)).json()) as Question).phase).toBe("ヒント");
  });
});

describe("採番", () => {
  it("問題の行が消えていても、既存の問題と同じ id を振らず、上書きしない", async () => {
    const a = (await (await start({ claimId: CLAIM })).json()) as Question;
    const b = (await (await start({ claimId: CLAIM })).json()) as Question;
    const lines = ((await (await caseOf(b.id)).json()) as ClaimContext).lines;
    expect((await draft(b.id, { lines })).status).toBe(200);
    // 先の問題の行が消えると、件数から振る番号は b と同じになる
    const db = new Database(instance.tenantPaths(user.tenantId).dbFile);
    db.prepare("DELETE FROM questions WHERE id = ?").run(a.id);
    db.close();
    const c = (await (await start({ claimId: CLAIM })).json()) as Question;
    expect(Number(c.id.slice(1))).toBe(Number(b.id.slice(1)) + 1);
    expect(c.id).toMatch(/^q\d{4}$/);
    // b は下書きを持ったまま残っている
    expect(((await (await one(b.id)).json()) as Question).drafts).toHaveLength(1);
  });
});

describe("所有", () => {
  it("同じクリニックのほかの人の問題は、ないものとして扱う（404）。問題は変わらない", async () => {
    const other = othersQuestion();
    const lines = instance.runAs(user, () => instance.getApp().caseOf(CLAIM).lines);
    const all = [
      await one(other.id),
      await caseOf(other.id),
      await drill(other.id),
      await choices(other.id),
      await pick(other.id, { lineIndex: 0, option: "判定不能" }),
      await draft(other.id, { lines }),
      await confirm(other.id, { lines }),
      await explain(other.id),
      await done(other.id),
      await localRules(other.id, { lines }),
    ];
    for (const r of all) {
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe(`問題がない: ${other.id}`);
    }
    // 本当にない問題と同じ応答
    const none = await one("q9999");
    expect(none.status).toBe(404);
    expect((await none.json()).error).toBe("問題がない: q9999");
    expect(instance.runAs(user, () => instance.getApp().question(other.id))).toMatchObject({ clerkId: "vet1", phase: "ヒント", drafts: [], confirmed: null });
    // 当てはまるローカルルール（読み取り相当）は監査ログに残さない。最後の行は、その前の「終える」
    expect(auditRows()[0]).toMatchObject({ action: "POST /api/questions/[id]/done", target: other.id, result: "rejected", status: 404 });
    expect(auditRows().some((r) => r.action === "POST /api/questions/[id]/local-rules")).toBe(false);
  });
});
