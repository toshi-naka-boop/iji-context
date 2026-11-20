// 基本マスター（masters.db）があるときと、ないときの、取り込んだレセプトの点検・試算・月末の点検の確定（design.md §12-4・§12-5）。実際のルートを呼んで確かめる。
// データは同梱しないので、手で作った数行の表（tests/generic/small-masters.ts）を RESEMEN_MASTER_DIR に置く。実データでの確認は tests/generic/real.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Finding } from "../../src/engine/types";
import type { RowNames } from "../../src/generic/lookup";
import type { GenericView } from "../../src/generic/view";
import type { User } from "../../src/server/auth";
import { put, smallMasters } from "../generic/small-masters";
import { autoConsent } from "../helpers/consent";
import { claimId, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
const before = process.env.RESEMEN_MASTER_DIR;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-uke-masters-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  // 小さな masters.db：版のコードの表の診療行為と、taishogai.UKE の対象外の単位にある加算（往診料と同じ区分番号 C000 の、表にないコード）
  mkdirSync(path.join(tmp, "m"));
  const db = smallMasters(path.join(tmp, "m", "masters.db"));
  put(db, "shinryo", "20261001", { code: "114704470", name: "手作りの加算（往診料）", alpha: "C", sho: 2, bu: 2, kubun_no: 0 });
  db.close();
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
  if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
  else process.env.RESEMEN_MASTER_DIR = before;
});
/** masters.db のない場所／小さな masters.db のある場所 */
const noMasters = () => (process.env.RESEMEN_MASTER_DIR = path.join(tmp, "none"));
const withMasters = () => (process.env.RESEMEN_MASTER_DIR = path.join(tmp, "m"));

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string) => new Request(`http://localhost${url}`, { headers: { cookie } });
function upload(cookie: string, bytes: Uint8Array): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart]), "upload.UKE");
  return new Request("http://localhost/api/uke/upload", { method: "POST", headers: { cookie }, body: form });
}
const sample = (name: string) => readFileSync(path.join(repo, "fixtures", "uke", name));
type Check = {
  partial: boolean;
  subtotal: number | null;
  others: { codes: string[] }[];
  findings: Finding[];
  missing: Finding[];
  comments: { code: string; text: string }[];
  names?: RowNames;
  diseases: { code: string; name: string | null; main: boolean }[];
  generic: GenericView;
  stopped: { ruleId: string; all: boolean; dropped: boolean; codes: { code: string; known: boolean; name: string | null; no: string | null }[] }[];
};
const check = async (id: string, cookie: string) =>
  (await (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(get(`/api/uke/claims/${id}/check`, cookie), { params: Promise.resolve({ claimId: id }) })).json() as Promise<Check>;
const trial = async (id: string, rev: string, cookie: string) =>
  (await (await import("../../app/api/uke/claims/[claimId]/trial/route")).GET(get(`/api/uke/claims/${id}/trial?rev=${rev}`, cookie), { params: Promise.resolve({ claimId: id }) })).json() as Promise<Check>;

describe("取り込んだレセプトの点検：基本マスターがあるとき・ないとき", () => {
  let cookie: string;
  let owner: User;
  const unsupported = (c: Check) => c.missing.filter((m) => m.missing?.field === "unsupportedLines").map((m) => m.ruleId);

  it("マスターがなければ、今までどおり：名称は付かず（コードだけ）、対象外の行があればどのルールも止め、データで動く点検は「していません」と返す", async () => {
    noMasters();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    owner = auth().register("uke_masters_a", "やまだ", "password123");
    cookie = cookieOf(owner);
    expect((await (await import("../../app/api/uke/upload/route")).POST(upload(cookie, sample("taishogai.UKE")))).status).toBe(200);
    const c = await check("U1-1", cookie);
    expect("names" in c).toBe(false);
    expect(c.others.map((o) => o.codes)).toEqual([["114000110", "114704470"]]);
    expect([c.generic.findings, c.generic.ran]).toEqual([[], []]);
    expect(c.generic.notRun[0]).toEqual({ check: "G01", kind: "コード", reason: "noMasters", text: "マスターが入っていないので、していません" });
    expect(c.generic.notRun.slice(1).every((n) => n.reason === "notBuilt")).toBe(true);
    // どのルールも partial（ルールごとには決められない）。dropped は、指摘を実際に捨てたルール（情報不足 unsupportedLines が出ている）
    expect(c.stopped.map((s) => s.ruleId)).toEqual(r2026.rules.map((r) => r.id));
    expect(c.stopped.every((s) => s.all && s.codes.length === 0)).toBe(true);
    expect(c.stopped.filter((s) => s.dropped).map((s) => s.ruleId)).toEqual(unsupported(c));
    // 傷病名は、表にあるものだけ名称が付く（EM §2-8）
    expect(c.diseases).toEqual([{ code: "2500015", name: "２型糖尿病", main: true }, { code: "8833421", name: "高血圧症", main: false }]);
    await instance.runAs(owner, () => expect(instance.getApp().caseOf("U1-1").outside).toBeUndefined());
  });

  it("マスターがあれば：対象外の行にも名称と区分番号が付き、G01 が動き、止まるのは対象外の行と同じ区分番号を読むルールだけ", async () => {
    noMasters();
    const without = await check("U1-1", cookie);
    withMasters();
    const c = await check("U1-1", cookie);
    // 行の名称：点検した行のコードも、対象外の単位のコードも
    expect(c.names!.items["114000110"]).toEqual({ name: r2026.points.C000.name, no: "C000" });
    expect(c.names!.items["114704470"]).toEqual({ name: "手作りの加算（往診料）", no: "C000" });
    expect(c.names!.items[r2026.codes.C001_1I.primary]).toEqual({ name: r2026.points.C001_1I.name, no: "C001" });
    expect(c.names!.comments).toEqual({ "850100106": "手作りのコメントの定型文" });
    // G01：動いた。小さな表にない項目（包括の検査の項目）が、条件つきで出る。言い切りは 1 件もない
    expect(c.generic.ran).toEqual([{ check: "G01", kind: "コード" }]);
    expect(c.generic.findings.length).toBeGreaterThan(0);
    expect(c.generic.findings.every((f) => f.check === "G01" && f.certainty === "条件つき" && f.text.includes("持っているどの版のマスターにもありません"))).toBe(true);
    expect(c.generic.findings.flatMap((f) => f.codes.map((x) => x.code))).not.toContain("114704470");
    // 止まるルール：往診料（C000）を読むルールだけ。止めた行と、その区分番号を返す
    expect(c.stopped.map((s) => s.ruleId)).toEqual(r2026.rules.filter((r) => r.reads!(r2026).some((k) => k.startsWith("C000"))).map((r) => r.id));
    expect(c.stopped.map((s) => s.ruleId)).toEqual(["R08", "R10", "R11", "R15", "R17"]);
    for (const s of c.stopped) {
      expect(s.all, s.ruleId).toBe(false);
      expect(s.codes, s.ruleId).toEqual([{ code: "114000110", known: true, name: r2026.points.C000.name, no: "C000" }, { code: "114704470", known: true, name: "手作りの加算（往診料）", no: "C000" }]);
    }
    expect(c.stopped.filter((s) => s.dropped).map((s) => s.ruleId)).toEqual(unsupported(c));
    // 止まらないルール（管理料の区分など）は、対象外の単位がない請求と同じに判定する：マスターがないときの「決められません」が減る
    expect(unsupported(c).length).toBeLessThanOrEqual(unsupported(without).length);
    // 合計の出し方は変わらない：対象外の単位があれば、小計と UKE の合計を分けて出す
    expect([c.partial, c.subtotal]).toEqual([true, without.subtotal]);
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      expect(a.caseOf("U1-1").outside!.codes).toEqual([{ code: "114000110", known: true, no: "2/2/0" }, { code: "114704470", known: true, no: "2/2/0" }]);
      const q = a.start(instance.clerkIdOf(owner), "U1-1");
      const result = a.confirm(q.id, a.caseFor(q).lines).confirmed!.result;
      expect([result.total, result.subtotal]).toEqual([null, c.subtotal]);
    });
  });

  it("試算でも、選んだ版の世代のマスターで、名称・G01・ルールごとの partial が付く", async () => {
    withMasters();
    const t = await trial("U1-1", r2026.id, cookie);
    expect(t.names!.items["114704470"]).toEqual({ name: "手作りの加算（往診料）", no: "C000" });
    expect(t.generic.ran).toEqual([{ check: "G01", kind: "コード" }]);
    expect(t.stopped.every((s) => !s.all)).toBe(true);
    noMasters();
    const none = await trial("U1-1", r2026.id, cookie);
    expect("names" in none).toBe(false);
    expect(none.stopped.every((s) => s.all)).toBe(true);
  });

  it("対象外の行のない請求（同梱の症例）：マスターがあってもなくても、手書きのルールの指摘・小計は同じ", async () => {
    noMasters();
    const a = await check(claimId("K1"), cookie);
    withMasters();
    const b = await check(claimId("K1"), cookie);
    expect([b.findings, b.missing, b.subtotal, b.partial, b.stopped]).toEqual([a.findings, a.missing, a.subtotal, false, []]);
    expect(b.generic.ran).toEqual([{ check: "G01", kind: "コード" }]);
  });
});

describe("月末の点検（行を入力する問題）の確定：区分をコードに直して G01 を掛けた結果を添える", () => {
  it("確定の応答に generic が付く。問題には保存しない", async () => {
    const owner = auth().register("uke_masters_q", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const confirm = async (rmd: () => string) => {
      rmd();
      const q = await instance.runAs(owner, () => {
        const a = instance.getApp();
        a.importUke(instance.clerkIdOf(owner), "kokuhoren.UKE");
        a.importUke(instance.clerkIdOf(owner), "shiharaikikin.UKE");
        return a.start(instance.clerkIdOf(owner), claimId("K1"));
      });
      const lines = await instance.runAs(owner, () => instance.getApp().caseFor(q).lines);
      const res = await (await import("../../app/api/questions/[id]/confirm/route")).POST(
        new Request(`http://localhost/api/questions/${q.id}/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ lines }) }),
        { params: Promise.resolve({ id: q.id }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { phase: string; generic: GenericView & { skippedLines: number } };
      expect(body.phase).toBe("判定");
      await instance.runAs(owner, () => expect("generic" in instance.getApp().question(q.id)).toBe(false));
      return { generic: body.generic, lines };
    };
    const none = await confirm(noMasters);
    expect([none.generic.ran, none.generic.notRun[0].reason]).toEqual([[], "noMasters"]);
    const some = await confirm(withMasters);
    expect([some.generic.ran, some.generic.findings]).toEqual([[{ check: "G01", kind: "コード" }], []]);
    // コードに直せない行（包括の検査の区分）は掛けていない。その数を返す
    expect(some.generic.skippedLines).toBe(some.lines.filter((l) => !Object.hasOwn(r2026.codes, l.kubun)).length);
    expect(YM).toMatch(/^\d{4}-\d{2}$/);
  });
});
