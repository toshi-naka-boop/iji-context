// 取り込んだ請求にカルテを貼る（design.md §15-8・§15-9。段 18c）を、ルートを実際に呼んで確かめる：貼る → 行ったことを確かめる → 点検の B の欄。
// LLM は呼ばない（SDK の query を差し替える）。マスターは作り物の小さな表（tests/generic/small-tensuhyo.ts）を RESEMEN_MASTER_DIR に置く。UKE は同梱の合成データ torikawasure.UKE（K8〜K11）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import { autoConsent } from "../helpers/consent";
import { tensuhyoMasters } from "../generic/small-tensuhyo";
import { put } from "../generic/small-masters";
import Database from "better-sqlite3";
import { r2026 } from "../../src/engine/revisions/r2026";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
const before = process.env.RESEMEN_MASTER_DIR;
const repo = path.join(__dirname, "..", "..");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-uke-notes-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  const dir = path.join(tmp, "masters");
  mkdirSync(dir);
  const db = tensuhyoMasters("20261001");
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
  put(db, "shinryo", "20261001", { code: "140000610", name: "創傷処置（１００ｃｍ２未満）", alpha: "J" });
  if (!db.prepare("SELECT 1 FROM shinryo WHERE snapshot = '20261001' AND code = '130000510'").get()) put(db, "shinryo", "20261001", { code: "130000510", name: "皮内、皮下及び筋肉内注射", alpha: "G" });
  writeFileSync(path.join(dir, "masters.db"), db.serialize());
  db.close();
  process.env.RESEMEN_MASTER_DIR = dir;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("uke_notes_owner", "はりつけ", "password123", "demo");
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
});

const get = (url: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

type Check = { findings: { messageKey: string }[]; missing: unknown[]; recordsKnown: boolean; torikawasure: { skip?: string; coverage?: string; findings?: { messageKey: string; codes: string[] }[] } };
const check = async (claimId: string) => {
  const r = await (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(get(`/api/uke/claims/${claimId}/check`), { params: Promise.resolve({ claimId }) });
  expect(r.status).toBe(200);
  return (await r.json()) as Check;
};

describe("取り込んだ請求にカルテを貼る（POST /api/uke/claims/[claimId]/notes）", () => {
  it("同じ月に取り込んだ請求のうち 1 件だけに貼ると、貼った患者だけを見ている 1 行が出て、貼っていない請求は取り忘れを見ない。貼った請求では G11 が動き、手書きのルールの指摘は貼る前と同じ", async () => {
    const buf = readFileSync(path.join(repo, "fixtures", "uke", "torikawasure.UKE"));
    const imported = instance.runAs(user, () => instance.getApp().uploadUke(instance.clerkIdOf(user), buf)) as unknown;
    expect(imported).toBeTruthy();
    const ids = instance.runAs(user, () => instance.getApp().importedClaims(instance.clerkIdOf(user)));
    expect(ids.length).toBe(4);
    const [mine, ...others] = ids;
    const before = await check(mine);
    expect(before.torikawasure).toEqual({ skip: "カルテが貼られていないので、取り忘れは見ていません", coverage: "カルテを貼った患者だけを見ています（貼った 0 人・貼っていない 4 人）" });

    // 貼る（AI が行ったことを取り出す。ここでは返事を差し替える）。請求にない行為（創傷処置）を書く
    const note = { s: "", o: "創傷処置（１００ｃｍ２未満）。", a: "", p: "", rx: "" };
    llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [{ category: "処置", written: "創傷処置（１００ｃｍ２未満）", lookup: [], quote: "創傷処置（１００ｃｍ２未満）" }], rx: [] }, sessionId: "", stats: {} });
    const pasted = await (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST(post(`/api/uke/claims/${mine}/notes`, { date: "2026-10-14", note }), { params: Promise.resolve({ claimId: mine }) });
    expect(pasted.status).toBe(200);
    const p = (await pasted.json()) as { id: number; acts: unknown[]; review: { matches: { act: { initial: unknown } }[] } };
    // 診療年月の外の日付は 400
    const outside = await (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST(post(`/api/uke/claims/${mine}/notes`, { date: "2026-11-01", note }), { params: Promise.resolve({ claimId: mine }) });
    expect(outside.status).toBe(400);
    // 暦にない日は 400（反証 round-55 C-301）
    for (const date of ["2026-10-32", "2026-10-00", "2026-02-30"]) {
      const bad = await (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST(post(`/api/uke/claims/${mine}/notes`, { date, note }), { params: Promise.resolve({ claimId: mine }) });
      expect([date, bad.status]).toEqual([date, 400]);
    }
    // 確かめて残す（今のカルテと同じ入口）
    const acts = (p.acts as Record<string, unknown>[]).map((a, i) => ({ ...a, match: p.review.matches[i].act.initial ?? { tbl: "shinryo", code: "140000610", name: "創傷処置（１００ｃｍ２未満）", by: "search" } }));
    const saved = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(p.id), facts: [], acts, rx: [] }));
    expect([saved.status, saved.status === 200 ? "" : await saved.text()]).toEqual([200, ""]);

    const after = await check(mine);
    expect(after.recordsKnown).toBe(false);
    expect(after.findings).toEqual(before.findings);
    expect(after.missing).toEqual(before.missing);
    expect(after.torikawasure.coverage).toBe("カルテを貼った患者だけを見ています（貼った 1 人・貼っていない 3 人）");
    expect(after.torikawasure.findings?.map((f) => `${f.messageKey} ${f.codes.join("+")}`)).toEqual(["G11.missing 140000610"]);
    for (const id of others) {
      const o = await check(id);
      expect([id, o.torikawasure]).toEqual([id, { skip: "カルテが貼られていないので、取り忘れは見ていません", coverage: "カルテを貼った患者だけを見ています（貼った 1 人・貼っていない 3 人）" }]);
    }
    // 段の報告：1 人あたりの貼った回数（記録から数える）
    const counts = instance.runAs(user, () => instance.getApp().recordCounts());
    console.log(`段 18c の報告：貼った患者 ${counts.size} 人、1 人あたりの貼った回数 ${[...counts.values()].reduce((s, n) => s + n, 0) / Math.max(1, counts.size)}`);
    // 貼ったカルテは訪問・往診の出来事を作らない（記録の種類）
    const listed = instance.runAs(user, () => instance.getApp().listNotes(instance.clerkIdOf(user), user.role));
    expect(listed.find((n) => n.id === p.id)?.kind).toBe("記録");
  });
});

describe("取り込んだ請求の月末の点検の B の欄（反証 round-55 C-290）", () => {
  it("取り込んだ請求の月末の点検は、確定した明細の行ではなく UKE の単位と突き合わせる：UKE に載っている注射（版の区分にない行）を取り忘れと言わず、点検の画面の B の欄と同じになる", async () => {
    const clerkId = instance.clerkIdOf(user);
    const [mine] = instance.runAs(user, () => instance.getApp().importedClaims(clerkId));
    const note = { s: "", o: "皮内、皮下及び筋肉内注射。", a: "", p: "", rx: "" };
    llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [{ category: "注射", written: "皮内、皮下及び筋肉内注射", lookup: [], quote: "皮内、皮下及び筋肉内注射" }], rx: [] }, sessionId: "", stats: {} });
    const pasted = await (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST(post(`/api/uke/claims/${mine}/notes`, { date: "2026-10-14", note }), { params: Promise.resolve({ claimId: mine }) });
    expect(pasted.status).toBe(200);
    const p = (await pasted.json()) as { id: number; acts: Record<string, unknown>[] };
    const match = { tbl: "shinryo", code: "130000510", name: "皮内、皮下及び筋肉内注射", by: "search" };
    const saved = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(p.id), facts: [], acts: p.acts.map((a) => ({ ...a, match })), rx: [] }));
    expect(saved.status).toBe(200);
    const fromCheck = (await check(mine)).torikawasure;
    expect(fromCheck.findings?.map((f) => `${f.messageKey} ${f.codes.join("+")}`)).toEqual(["G11.missing 140000610"]);
    const base = instance.runAs(user, () => instance.getApp().caseOf(mine));
    const q = { id: "q-mine", claimId: mine, clerkId, confirmed: { lines: base.lines, result: { findings: [], applied: [] } } };
    const month = instance.runAs(user, () => instance.getApp().questionGeneric(q as never)) as { torikawasure: { findings: { messageKey: string; codes: string[] }[] } };
    expect(month.torikawasure.findings.map((f) => `${f.messageKey} ${f.codes.join("+")}`)).toEqual(["G11.missing 140000610"]);
  });
});

describe("区分誤りの出た対応は消さずに、読むときに外す（反証 round-55 C-293・C-300）", () => {
  it("施設の種別と合わない区分の在医総管を選んだ対応は、点検（GET）を開いても消えず、次の確かめでは初期値にも「前に選んだもの」にもならない。種別に合う区分の対応は初期値になる", async () => {
    const clerkId = instance.clerkIdOf(user);
    const [mine] = instance.runAs(user, () => instance.getApp().importedClaims(clerkId));
    const aliases = () => {
      const db = new Database(instance.tenantPaths(user.tenantId).dbFile, { readonly: true });
      try {
        return db.prepare("SELECT written_norm, tbl, code FROM chart_act_aliases ORDER BY written_norm, code").all();
      } finally {
        db.close();
      }
    };
    const paste = async (written: string) => {
      llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [{ category: "診療行為", written, lookup: [], quote: written }], rx: [] }, sessionId: "", stats: {} });
      const r = await (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST(post(`/api/uke/claims/${mine}/notes`, { date: "2026-10-28", note: { s: "", o: `${written}。`, a: "", p: "", rx: "" } }), { params: Promise.resolve({ claimId: mine }) });
      expect(r.status).toBe(200);
      return (await r.json()) as { id: number; acts: Record<string, unknown>[]; review: { aliasCount: number; matches: { act: { initial: { code: string; by: string } | null; candidates: { code: string; prior: boolean }[] } }[] } };
    };
    const choose = async (p: { id: number; acts: Record<string, unknown>[] }, code: string) => {
      const saved = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(p.id), facts: [], acts: p.acts.map((a) => ({ ...a, match: { tbl: "shinryo", code, name: "在医総管", by: "search" } })), rx: [] }));
      expect([saved.status, saved.status === 200 ? "" : await saved.text()]).toEqual([200, ""]);
    };
    // 申告の種別は 2（config/facility.json）。機能強化型・病床なしの区分（C002_1N_RO1）は R18 の同じ族の区分誤り
    const wrong = r2026.codes.C002_1N_RO1.primary;
    await choose(await paste("在宅時医学総合管理料（強化）"), wrong);
    const before = aliases();
    expect(before).toContainEqual({ written_norm: expect.any(String), tbl: "shinryo", code: wrong });
    const checked = await check(mine);
    expect(checked.torikawasure.findings?.some((f) => f.codes.includes(wrong))).toBe(true);
    expect(aliases()).toEqual(before);
    const next = await paste("在宅時医学総合管理料（強化）");
    expect(next.review.matches[0].act.initial?.by).not.toBe("alias");
    expect(next.review.matches[0].act.candidates.some((c) => c.prior)).toBe(false);
    expect(next.review.aliasCount).toBe(0);
    // 種別に合う区分の対応は初期値になる
    const right = r2026.codes.C002_2RO1.primary;
    await choose(await paste("在宅時医学総合管理料（在支診）"), right);
    expect((await paste("在宅時医学総合管理料（在支診）")).review.matches[0].act.initial).toMatchObject({ code: right, by: "alias" });
  });
});

describe("算定プレビュー・月末の点検の応答にも B の欄（path: preview。利用者の判断 2026-11-23）", () => {
  it("合成の症例に本人がカルテを書いて行ったことを確かめると、算定プレビューと月末の点検の応答の B の欄に、請求にない行為が同じ指摘で出る", async () => {
    const claimId = "K4-2026-10";
    const note = { s: "", o: "在宅患者訪問診療。創傷処置（１００ｃｍ２未満）。", a: "", p: "", rx: "" };
    llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: [{ category: "処置", written: "創傷処置（１００ｃｍ２未満）", lookup: [], quote: "創傷処置（１００ｃｍ２未満）" }], rx: [] }, sessionId: "", stats: {} });
    const w = await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId, kind: "訪問診療", note }));
    expect(w.status).toBe(200);
    const id = ((await w.json()) as { id: number }).id;
    const match = { tbl: "shinryo", code: "140000610", name: "創傷処置（１００ｃｍ２未満）", by: "search" };
    const c = await (await import("../../app/api/chart/acts/route")).POST(post("/api/chart/acts", { noteId: String(id), facts: [], acts: [{ category: "処置", written: "創傷処置（１００ｃｍ２未満）", lookup: [], quote: "創傷処置（１００ｃｍ２未満）", match }], rx: [] }));
    expect(c.status).toBe(200);
    // 算定プレビュー（GET /api/chart/[id]/claim）
    const r = await (await import("../../app/api/chart/[id]/claim/route")).GET(get(`/api/chart/${id}/claim`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    const preview = ((await r.json()) as { torikawasure: { findings: { messageKey: string; codes: string[] }[]; scope: string[] } }).torikawasure;
    expect(preview.findings.map((f) => `${f.messageKey} ${f.codes.join("+")}`)).toEqual(["G11.missing 140000610"]);
    // 月末の点検（確定した明細の応答。questionGeneric）
    const clerkId = instance.clerkIdOf(user);
    const base = instance.runAs(user, () => instance.getApp().caseOf(claimId));
    const q = { id: "q-k4", claimId, clerkId, confirmed: { lines: base.lines, result: { findings: [], applied: [] } } };
    const month = instance.runAs(user, () => instance.getApp().questionGeneric(q as never)) as { torikawasure: { findings: { messageKey: string; codes: string[] }[] } };
    expect(month.torikawasure.findings.map((f) => `${f.messageKey} ${f.codes.join("+")}`)).toEqual(["G11.missing 140000610"]);
  });
});
