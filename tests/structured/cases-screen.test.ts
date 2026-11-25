// 段 19h（design.md §16-10）の受け入れの症例 K12・K13 を画面の経路で：デモのクリニックで見本の kozoka.UKE を取り込み（POST /api/uke）、
// 取り込んだ請求の点検の画面（GET /api/uke/claims/[claimId]/check）で合成の接続先から構造化データを読んで残し、月末の点検の B の欄（questionGeneric）に規則の候補が出る。
// 前の 12 か月の処方のオーダーは「受け取っている・0 件」として残る（EM §5-1 の K12 の行）。AI は呼ばない。
// 実データの masters.db（RESEMEN_MASTER_DIR）があるときだけ動く（ないときは飛ばした数を出す）
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { G11Finding } from "../../src/generic/g11";
import type { User } from "../../src/server/auth";
import { RULE_CODES as R } from "../../src/structured/rule-codes";
import { autoConsent } from "../helpers/consent";
import { month, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
const dir = process.env.RESEMEN_MASTER_DIR;
const has = !!dir && existsSync(path.join(dir, "masters.db"));
let skipped = 0;
const withData = (name: string, fn: () => Promise<void>) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-cases-screen-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("cases_screen", "うけいれ", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  if (!has) process.stderr.write(`段 19h の画面の経路のテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});
const app = () => instance.getApp();
const as = <T,>(fn: () => T) => instance.runAs(user, fn);
const req = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });

describe("構造化データつきの見本（kozoka.UKE）は、取り込んだときから見本に並ぶ（見本の 2 本の一覧と請求は今までどおり）", () => {
  it("取り込む前は一覧・請求に出ない。ダウンロードはでき、同じ内容をアップロードすると見本として取り込み、請求に並ぶ（請求 id は症例の番号のまま）", async () => {
    const clerkId = instance.clerkIdOf(user);
    expect(as(() => app().ukeList(clerkId)).map((u) => u.name)).toEqual(["kokuhoren.UKE", "shiharaikikin.UKE"]);
    expect(as(() => app().cases()).some((c) => c.claimId === "K12")).toBe(false);
    const { GET } = await import("../../app/api/uke/sample/route");
    const res = await GET(req("/api/uke/sample?name=kozoka.UKE"));
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(readFileSync(path.join(repo, "fixtures", "uke", "kozoka.UKE")))).toBe(true);
    const list = as(() => app().uploadUke(clerkId, bytes));
    expect(list.map((u) => [u.name, u.uploaded, u.imported, u.receipts.map((x) => x.claimId).join(",")])).toEqual([
      ["kokuhoren.UKE", false, false, "K1-2026-10,K2-2026-10,K3-2026-10,K4-2026-10,K5-2026-10,K7-2026-10"],
      ["shiharaikikin.UKE", false, false, "K6-2026-10"],
      ["kozoka.UKE", false, true, "K12,K13"],
    ]);
    expect(as(() => app().cases()).filter((c) => c.claimId === "K12" || c.claimId === "K13").map((c) => c.claimId)).toEqual(["K12", "K13"]);
    // 訪問の記録の一覧も、処方の一覧を持たない合成カルテ（K12・K13）のまま開ける
    const visits = await (await import("../../app/api/visits/route")).GET(req("/api/visits"));
    expect(visits.status).toBe(200);
    expect(((await visits.json()) as { claimId: string }[]).some((v) => v.claimId === "K12")).toBe(true);
    // 名前で取り込んでも（画面の「構造化データつきの見本（K12・K13）を取り込む」）、見本に加わる（別のクリニックの利用者で確かめる）
    const other = instance.getAuth().register("cases_screen2", "うけいれ二", "password123");
    const byName = instance.runAs(other, () => {
      const id = instance.clerkIdOf(other);
      const before = app().ukeList(id).map((u) => u.name);
      return { before, after: app().importUke(id, "kozoka.UKE").map((u) => [u.name, u.imported]) };
    });
    expect(byName.before).toEqual(["kokuhoren.UKE", "shiharaikikin.UKE"]);
    expect(byName.after).toEqual([
      ["kokuhoren.UKE", false],
      ["shiharaikikin.UKE", false],
      ["kozoka.UKE", true],
    ]);
  });
});

describe("段 19h：K12・K13 を画面の経路で（見本の取り込み → 点検の画面 → 月末の点検の B の欄）", () => {
  withData("見本の kozoka.UKE を取り込むと K12・K13 が取り込んだ請求に並び、点検の画面を開くと構造化データが残り、月末の点検の B の欄に規則の候補（G11.missing_rule）が出る", async () => {
    const clerkId = instance.clerkIdOf(user);
    const { POST } = await import("../../app/api/uke/route");
    const imported = await POST(req("/api/uke", { name: "kozoka.UKE" }));
    expect(imported.status).toBe(200);
    const list = (await imported.json()) as { name: string; uploaded: boolean; imported: boolean; receipts: { claimId: string }[] }[];
    expect(list.map((u) => [u.name, u.uploaded, u.imported])).toEqual([
      ["kokuhoren.UKE", false, false],
      ["shiharaikikin.UKE", false, false],
      ["kozoka.UKE", false, true],
    ]);
    expect(as(() => app().importedClaims(clerkId))).toEqual(["K12", "K13"]);

    const { GET } = await import("../../app/api/uke/claims/[claimId]/check/route");
    const codesOf = (fs: G11Finding[]) => fs.filter((f) => f.messageKey === "G11.missing_rule").map((f) => f.codes.join("+"));
    const out: Record<string, string[]> = {};
    for (const id of ["K12", "K13"]) {
      expect((await GET(req(`/api/uke/claims/${id}/check`), { params: Promise.resolve({ claimId: id }) })).status).toBe(200);
      const pid = as(() => app().structuredPatientOf(id));
      const stored = as(() => app().storedStructured(pid, YM))!;
      expect([id, stored.connectorId, stored.chart.visits.status, stored.chart.orders.status, stored.chart.procedures.status, stored.chart.homeCare.status]).toEqual([id, "fixture", "supported", "supported", "supported", "supported"]);
      // 前の 12 か月の処方のオーダーは、受け取っている・0 件（読めない月にしない）
      for (let i = 1; i <= 12; i++) {
        const past = as(() => app().storedStructured(pid, month(-i)))!.chart.orders;
        expect([id, month(-i), past.status, past.status === "supported" ? past.items.length : null]).toEqual([id, month(-i), "supported", 0]);
      }
      // 月末の点検の B の欄（合成の症例は確定した明細の行と突き合わせる）
      const base = as(() => app().caseOf(id));
      const q = { id: `q-${id}`, claimId: id, clerkId, confirmed: { lines: base.lines, result: { findings: [], applied: [] } } };
      const month0 = as(() => app().questionGeneric(q as never)) as { torikawasure: { findings?: G11Finding[]; skip?: string } };
      expect([id, month0.torikawasure.skip]).toEqual([id, undefined]);
      out[id] = codesOf(month0.torikawasure.findings ?? []);
    }
    console.log(`段 19h 画面の経路の規則の候補：${JSON.stringify(out)}`);
    // 確定した明細の行は版の区分の行だけ（時間の加算・調剤料などの行を持たない）なので、規則で出す算定が候補に並ぶ。
    // 在医総管の月（K12）は時間の加算（70 分の日）だけで、調剤料・処方料は包括で出ない。在医総管のない月（K13）は往診の時間の加算と院内の日の投薬の算定
    expect(out.K12).toEqual([R.kakaVisit]);
    expect([...out.K13].sort()).toEqual([R.kakaOushin, `${R.mayakuChozai}+${R.mayakuShohoryo}`, R.chozaiOral, R.chozaiExternal, R.shohoryo3].sort());
  });
});
