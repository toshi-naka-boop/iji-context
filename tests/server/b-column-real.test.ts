// 段 18c の完了条件「K8〜K11 を開くと、B の欄に実データのテストと同じ指摘が出る」を応答で縛る（利用者の判断 2026-11-23）。
// K8〜K11 の UKE（torikawasure.UKE）を取り込み、合成カルテ（fixtures/charts/K8〜K11.json）の日ごとの文を貼って確かめると、
// 取り込んだレセプトの点検の応答の B の欄が、実データのテスト（tests/generic/g11-real.test.ts の正しい請求）と同じになる：
// 添え書きのない指摘 0 件、注意つきは K9 の中心静脈注射 1 件だけ（例外を名指し）、K10 の酸素吸入と酸素は言わなかった一覧に並ぶ。
// LLM は呼ばない（取り出しの返事を合成カルテの acts に差し替える）。実データ（masters.db）は同梱しないので、RESEMEN_MASTER_DIR があるときだけ動く
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { G11Finding, G11Result } from "../../src/generic/g11";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import { autoConsent } from "../helpers/consent";
import { chartOf, G11_CASES, repo } from "../generic/g11-helpers";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));

const dir = process.env.RESEMEN_MASTER_DIR;
const has = !!dir && existsSync(path.join(dir, "masters.db"));
let skipped = 0;
const withData = (name: string, fn: () => Promise<void>) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn, 120_000);
};

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
beforeAll(async () => {
  if (!has) return;
  tmp = mkdtempSync(path.join(tmpdir(), "iji-b-column-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("b_column_owner", "びーのらん", "password123", "demo");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  if (!has) process.stderr.write(`段 18c の B の欄の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const keys = (fs: G11Finding[]) => fs.map((f) => `${f.messageKey} ${f.codes.join("+")} ${f.days.map((d) => d.date.slice(8)).join(",")}${f.caution ? " 注意つき" : ""}`);
/** 実データのテスト（g11-real.test.ts）の正しい請求の期待 */
const CONDITIONAL: Record<string, string[]> = { K8: [], K9: ["G11.missing 130004410 28 注意つき"], K10: [], K11: [] };
const K9_NOTE = "在宅中心静脈栄養法指導管理料を算定する月は、原則として算定できません。例外：医療型短期入所サービス費等を算定している短期入所中の患者に行ったもの。当たらなければ、請求にないままで合っています";

describe("取り込んだレセプトの点検の応答の B の欄（K8〜K11 に合成カルテを貼る）", () => {
  withData("正しい請求で、添え書きのない指摘 0 件・注意つきは K9 の中心静脈注射 1 件だけ。K10 の酸素吸入と酸素は言わなかった一覧に並ぶ", async () => {
    const clerkId = instance.clerkIdOf(user);
    instance.runAs(user, () => instance.getApp().uploadUke(clerkId, readFileSync(path.join(repo, "fixtures", "uke", "torikawasure.UKE"))));
    const ids = instance.runAs(user, () => instance.getApp().importedClaims(clerkId));
    const paste = (await import("../../app/api/uke/claims/[claimId]/notes/route")).POST;
    const confirm = (await import("../../app/api/chart/acts/route")).POST;
    // 取り込んだ順（UKE の RE の並び：K8・K9・K10・K11）
    expect(ids).toHaveLength(4);
    for (const [i, k] of G11_CASES.entries()) {
      const claimId = ids[i];
      for (const e of chartOf(k).entries as unknown as { date: string; s: string; o: string; a: string; p: string; rx: string; acts: { match?: unknown }[]; rxNotes: { quote: string }[]; rxChoice: string | null }[]) {
        resetLimits();
        llm.runOnce.mockResolvedValueOnce({ structured: { facts: [], acts: e.acts.map(({ match: _m, ...a }) => a), rx: e.rxNotes }, sessionId: "", stats: {} });
        const r = await paste(post(`/api/uke/claims/${claimId}/notes`, { date: e.date, note: { s: e.s, o: e.o, a: e.a, p: e.p, rx: e.rx } }), { params: Promise.resolve({ claimId }) });
        expect([k, e.date, r.status]).toEqual([k, e.date, 200]);
        const p = (await r.json()) as { id: number };
        const c = await confirm(post("/api/chart/acts", { noteId: String(p.id), facts: [], acts: e.acts, rx: e.rxNotes, rxChoice: e.rxChoice }));
        expect([k, e.date, c.status, c.status === 200 ? "" : await c.text()]).toEqual([k, e.date, 200, ""]);
      }
    }
    for (const [i, k] of G11_CASES.entries()) {
      const res = await (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(new Request(`http://localhost/api/uke/claims/${ids[i]}/check`, { headers: { cookie } }), { params: Promise.resolve({ claimId: ids[i] }) });
      const b = ((await res.json()) as { torikawasure: G11Result & { coverage: string } }).torikawasure;
      if ("skip" in b) throw new Error(`${k}: ${b.skip}`);
      expect([k, keys(b.findings)]).toEqual([k, CONDITIONAL[k]]);
      expect([k, b.findings.filter((f) => !f.caution).length]).toEqual([k, 0]);
      expect(b.coverage).toBe("カルテを貼った患者だけを見ています（貼った 4 人・貼っていない 0 人）");
      if (k === "K9") expect(b.findings[0].days[0].notes.map((n) => n.text)).toEqual([K9_NOTE]);
      if (k === "K10") expect(b.hidden.filter((h) => h.reason === "背反").map((h) => [h.written, h.partner, h.with?.length])).toEqual([["酸素吸入", "在宅酸素療法指導管理料（その他）", 2]]);
      console.log(`${k} B の欄（応答）：指摘 ${JSON.stringify(b.counts.byKind)}・言わない ${JSON.stringify(b.counts.hidden)}・注意つき ${JSON.stringify(b.counts.caution)}`);
    }
    const counts = instance.runAs(user, () => instance.getApp().recordCounts());
    console.log(`段 18c の報告：貼った患者 ${counts.size} 人、1 人あたりの貼った回数 ${([...counts.values()].reduce((s, n) => s + n, 0) / counts.size).toFixed(1)}`);
  });
});
