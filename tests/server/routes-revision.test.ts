// 改定の比較（GET /api/revision/compare）と、算定プレビューの試算（GET /api/chart/[id]/claim?rev=）のルートを実際に呼んで確かめる（design.md §11-2・§11-12）。
// LLM（Agent SDK）は呼ばない。SDK の query を差し替える
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompareResult } from "../../src/engine/compare";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";
import { claimId, YM } from "../helpers/period";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-revision-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("revision_owner", "かいてい", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const get = (url: string, c: string | null = cookie) => new Request(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

type Compared = {
  claims: { claimId: string; patient: string }[];
  revisions: { id: string; label: string }[];
  result: (CompareResult & { claimId: string; yearMonth: string; from: { id: string; label: string }; to: { id: string; label: string } }) | null;
};
const compare = async (query: string, c: string | null = cookie) => (await import("../../app/api/revision/compare/route")).GET(get(`/api/revision/compare${query}`, c));

describe("GET /api/revision/compare", () => {
  it("ログインが要る。請求を省くと、比べられる請求（同梱の K1〜K7）と選べる版だけを返す", async () => {
    expect((await compare("", null)).status).toBe(401);
    const r = await compare("");
    expect(r.status).toBe(200);
    const d = (await r.json()) as Compared;
    expect(d.claims.map((c) => c.claimId).sort()).toEqual(["K1", "K2", "K3", "K4", "K5", "K6", "K7"].map(claimId));
    expect(d.revisions).toEqual([
      { id: "r2024", label: "令和6年度改定（最終状態）", own: false },
      expect.objectContaining({ id: "r2026" }),
      expect.objectContaining({ id: "r2027-06" }),
    ]);
    expect(d.result).toBeNull();
  });

  it("版を省くと、令和6年度の版と診療年月の版を比べる。K2 は訪問診療料が「点数」・物価対応料が「新設」、K7 は管理料が 1 行で「区分の変更」", async () => {
    const k2 = ((await (await compare(`?claimId=${claimId("K2")}`)).json()) as Compared).result!;
    expect([k2.claimId, k2.yearMonth, k2.from.id, k2.to.id]).toEqual([claimId("K2"), YM, "r2024", "r2026"]);
    expect(k2.from.label).toBe("令和6年度改定（最終状態）");
    expect(k2.totals).toEqual({ from: 6260, to: 6372 });
    expect(k2.rows.find((x) => x.group === "C001_1I")).toMatchObject({ change: "点数", from: { points: 888, count: 2 }, to: { points: 890, count: 2 } });
    expect(k2.rows.find((x) => x.group === "O100_1HA")).toMatchObject({ change: "新設", from: null });
    expect(k2.changes.length).toBeGreaterThan(0);

    const k7 = ((await (await compare(`?claimId=${claimId("K7")}&from=r2024&to=r2026`)).json()) as Compared).result!;
    expect(k7.totals).toEqual({ from: 6260, to: 4972 });
    expect(k7.rows.filter((x) => x.group === "在医総管")).toEqual([
      expect.objectContaining({ change: "区分の変更", from: expect.objectContaining({ kubun: "C002_2RO1", points: 3685 }), to: expect.objectContaining({ kubun: "C002_2NI1", points: 2285 }) }),
    ]);
  });

  it("版は id の列挙で検査する。ない請求は 404", async () => {
    for (const q of ["from=r1999", "to=latest", "from=r2024&to="]) {
      const r = await compare(`?claimId=${claimId("K2")}&${q}`);
      expect([q, r.status]).toEqual([q, 400]);
    }
    expect((await compare(`?claimId=${claimId("K9")}`)).status).toBe(404);
    expect((await compare("?claimId=../x")).status).toBe(400);
    // 選べる版どうしなら、どの組み合わせでも比べられる
    const r = ((await (await compare(`?claimId=${claimId("K2")}&from=r2026&to=r2027-06`)).json()) as Compared).result!;
    expect([r.from.id, r.to.id, r.totals.from]).toEqual(["r2026", "r2027-06", 6372]);
  });

  it("全ロールに開く（権限表の行）。患者の情報を返すので、同意が要る", async () => {
    const { POLICY } = await import("../../src/server/policy");
    expect(POLICY["GET /api/revision/compare"]).toEqual({ rule: ["clerk", "veteran", "manager", "doctor"], external: "none", patientData: true });
  });
});

describe("GET /api/chart/[id]/claim?rev=（試算）", () => {
  type Claim = { revisionId: string; lines: { kubun: string; points: number | null }[]; total: number | null; findings: unknown[]; trial?: { revisionId: string; claimYearMonth: string; inPeriod: boolean }; rulesAvailable?: boolean; notInRevision?: string[] };
  const NOTE = { s: "変わりなし", o: "血圧安定", a: "経過良好", p: "継続", rx: "" };

  it("rev を省くと今までどおり（試算の印を持たない）。rev を付けると、その版の点数表とルールでの試算になり、何も保存しない", async () => {
    llm.runOnce.mockResolvedValue({ structured: { facts: [] }, sessionId: "", stats: {} });
    const written = (await (await (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claimId("K2"), kind: "訪問診療", note: NOTE }))).json()) as { id: number };
    const id = String(written.id);
    expect((await (await import("../../app/api/chart/[id]/route")).POST(post(`/api/chart/${id}`, { facts: [] }), params({ id }))).status).toBe(200);
    const claim = (await import("../../app/api/chart/[id]/claim/route")).GET;
    const call = async (q = "") => {
      const r = await claim(get(`/api/chart/${id}/claim${q}`), params({ id }));
      return { status: r.status, body: (await r.json()) as Claim };
    };

    const plain = await call();
    expect(plain.status).toBe(200);
    expect(Object.keys(plain.body)).not.toEqual(expect.arrayContaining(["trial"]));
    expect(plain.body).not.toHaveProperty("rulesAvailable");
    expect(plain.body.revisionId).toBe("r2026");

    // 診療年月の版を名指しした試算：行・合計・指摘は、省いた呼び出しと同じ。試算の印だけが足される
    const same = await call("?rev=r2026");
    const { trial, rulesAvailable, notInRevision, ...rest } = same.body;
    expect(rest).toEqual(plain.body);
    expect([trial, rulesAvailable, notInRevision]).toEqual([{ revisionId: "r2026", claimYearMonth: YM, inPeriod: true }, true, []]);

    // 令和6年度の版：点数表が替わり、ルールは持っていない。適用期間の外
    const old = await call("?rev=r2024");
    expect(old.status).toBe(200);
    expect(old.body.trial).toEqual({ revisionId: "r2024", claimYearMonth: YM, inPeriod: false });
    expect([old.body.revisionId, old.body.rulesAvailable, old.body.findings]).toEqual(["r2024", false, []]);
    expect(old.body.lines.find((l) => l.kubun === "C001_1I")?.points).toBe(888);
    expect(old.body.lines.some((l) => l.kubun.startsWith("O100_"))).toBe(false);

    // 選べる版でない id は 400。試算のあとも、省いた呼び出しの結果は変わらない
    expect((await call("?rev=r1999")).status).toBe(400);
    expect((await call()).body).toEqual(plain.body);
  });
});
