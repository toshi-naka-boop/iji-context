// UKE のアップロードと見本のダウンロード（spec FR-106〜109）。実際のルート（app/api/uke/**/route.ts）を呼んで確かめる
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { pointsOf, resolveRevision } from "../../src/engine/revisions";
import { UKE_LIMITS } from "../../src/uke/limits";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { parseUke, writeUke } from "../../src/uke/uke";
import { claimId, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-uke-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const get = (url: string, cookie: string | null) => new Request(`http://localhost${url}`, { headers: cookie ? { cookie } : {} });
const postJson = (url: string, cookie: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const switchTo = async (cookie: string, role: Role) => (await import("../../app/api/auth/role/route")).POST(postJson("/api/auth/role", cookie, { role }));
/** 画面と同じ形（multipart/form-data の file）で送る */
function upload(cookie: string | null, bytes: Uint8Array, name = "upload.UKE"): Request {
  const form = new FormData();
  form.set("file", new Blob([bytes as BlobPart]), name);
  return new Request("http://localhost/api/uke/upload", { method: "POST", headers: cookie ? { cookie } : {}, body: form });
}
const routes = async () => ({
  upload: (await import("../../app/api/uke/upload/route")).POST,
  sample: (await import("../../app/api/uke/sample/route")).GET,
  list: (await import("../../app/api/uke/route")).GET,
});
const sample = (name: string) => readFileSync(path.join(repo, "fixtures", "uke", name));
const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
const textOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1));
/** そのクリニックの、アップロードした UKE の置き場にあるファイル */
const stored = (u: User): string[] => {
  const dir = path.join(path.dirname(instance.tenantPaths(u.tenantId).dbFile), "uke");
  return existsSync(dir) ? readdirSync(dir) : [];
};
type Listed = { name: string; imported: boolean; receipts: { claimId: string }[] }[];

describe("UKE のアップロード", () => {
  it("未ログインは 401、医師の役割は 403。ファイルがなければ 400", async () => {
    const r = await routes();
    expect((await r.upload(upload(null, sample("shiharaikikin.UKE")))).status).toBe(401);
    expect((await r.sample(get("/api/uke/sample?name=shiharaikikin.UKE", null))).status).toBe(401);
    const owner = auth().register("uke_owner_a", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const empty = new Request("http://localhost/api/uke/upload", { method: "POST", headers: { cookie }, body: new FormData() });
    expect((await r.upload(empty)).status).toBe(400);
    expect((await switchTo(cookie, "doctor")).status).toBe(200);
    expect((await r.upload(upload(cookie, sample("shiharaikikin.UKE")))).status).toBe(403);
    expect(stored(owner)).toEqual([]);
  });

  it("壊した UKE は、行番号つきの理由で 400。ファイルの中の値は返さず、何も保存しない・取り込まない", async () => {
    const r = await routes();
    const owner = auth().register("uke_owner_b", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const text = textOf(sample("shiharaikikin.UKE"));
    const rows = () => text.slice(0, -2).split("\r\n").map((l) => l.split(","));
    const withCell = (n: number, col: number, value: string) => {
      const x = rows();
      x[n - 1][col] = value;
      return enc(`${x.map((c) => c.join(",")).join("\r\n")}\r\n`);
    };
    /** 見本（K6）の行：1 IR・2 RE・3 HO・4 SY・5 SI・6 SI・7 GO */
    const broken: [string, Buffer, string][] = [
      ["列数の不足", enc(text.replace(/^(SI,.*),\r\n/m, "$1\r\n")), "5 行目：列数が合わない"],
      ["範囲外の数値", withCell(5, 6, "0"), "5 行目：回数が範囲の外"],
      ["表にないコード", withCell(5, 3, "160000310"), "5 行目：架空コードの表にないコード"],
      ["上限を超える日別回数", withCell(5, 13, "999999999"), "5 行目：1 日の回数が上限を超えている"],
      ["文字種の外の請求 id", withCell(2, 12, "../../etc/passwd"), "2 行目：請求 id に使えない文字がある"],
      ["版のない診療年月", withCell(2, 3, "202503"), "2 行目：診療年月に当たる版がない"],
      ["EOF なし", sample("shiharaikikin.UKE").subarray(0, -1), "末尾に EOF(0x1A) がない"],
      ["UKE でないバイト列", Buffer.from("%PDF-1.7\n".repeat(20)), "末尾に EOF(0x1A) がない"],
    ];
    const { resetLimits, limits } = await import("../../src/server/rate-limit");
    for (const [what, bytes, reason] of broken) {
      // 回数制限（1 分あたり）に当たらないよう、数え直す。回数制限そのものは下で確かめる
      resetLimits();
      const res = await r.upload(upload(cookie, bytes));
      const body = await res.text();
      expect([what, res.status, JSON.parse(body).error]).toEqual([what, 400, `この UKE は取り込めません（${reason}）`]);
      expect(body).not.toMatch(/160000310|passwd|六郎|01139997|999999999|PDF/);
    }
    expect(stored(owner)).toEqual([]);
    const list = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(list.map((u) => u.imported)).toEqual([false, false]);
    // 続けて送りすぎると 429（断られた分も数える）
    resetLimits();
    const statuses: number[] = [];
    for (let i = 0; i <= limits().upload.perMinute; i++) statuses.push((await r.upload(upload(cookie, broken[0][1]))).status);
    expect([statuses.slice(0, -1).every((s) => s === 400), statuses.at(-1)]).toEqual([true, 429]);
    resetLimits();
  });

  it("同梱の症例と同じ請求 id で見本と内容が違うものは断る（どちらを点検しているかが食い違うため）", async () => {
    const r = await routes();
    const owner = auth().register("uke_owner_c", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const text = textOf(sample("shiharaikikin.UKE"));
    const changed = await r.upload(upload(cookie, enc(text.replace("架空在宅クリニック", "架空在宅診療所"))));
    expect([changed.status, (await changed.json()).error]).toEqual([400, expect.stringContaining("2 行目：同梱の症例と同じ請求 id で、見本と内容が違う")]);
    // 症例の番号で始まる別の請求 id も、症例の事実に結びついてしまうので断る
    const prefixed = await r.upload(upload(cookie, enc(text.replace(claimId("K6"), "K6-other"))));
    expect([prefixed.status, (await prefixed.json()).error]).toEqual([400, expect.stringContaining("2 行目：同梱の症例と同じ請求 id")]);
    expect(stored(owner)).toEqual([]);
    expect(((await (await r.list(get("/api/uke", cookie))).json()) as Listed).map((u) => u.imported)).toEqual([false, false]);
  });

  it("見本と違う内容の UKE（同梱の症例にない患者・請求 id、複数レセプト）を受け取り、月末の点検に並べる。足りない事実は情報不足として出て、合計は出る", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_owner_g", "やまだ", "password123");
    const cookie = cookieOf(owner);
    // 見本のレセプトの行を借りて、架空の患者・別の請求 id のレセプトを 2 件作る（コードは架空コードの表のもの）
    const base = parseUke(sample("kokuhoren.UKE"));
    const linesOf = (k: string) => base.receipts.find((x) => x.claimId === claimId(k))!.lines;
    const person = (n: number, name: string): UkePatient => ({ name, sex: 2, birth: "19440505", receiptType: "1318", insurer: { number: "39139993", symbol: "", no: `0000009${n}` }, kohi: [], diseases: [{ name: "慢性心不全", start: "20250401", main: true }] });
    const X1 = `X1-${YM}`;
    const X2 = `X2-${YM}`;
    const file: UkeFile = {
      ...base,
      receipts: [
        // 在宅移行早期加算（退院・算定開始月の記録がないと決められない）を含む行
        { claimId: X1, yearMonth: YM, patient: person(1, "架空 花子"), lines: linesOf("K2"), comments: [] },
        // ターミナルケア加算（訪問の記録がないと決められない）を含む行
        { claimId: X2, yearMonth: YM, patient: person(2, "架空 月子"), lines: linesOf("K5"), comments: [] },
      ],
    };
    const bytes = writeUke(file);
    const name = `${createHash("sha256").update(bytes).digest("hex")}.UKE`;

    const res = await r.upload(upload(cookie, bytes, "../../x.UKE"));
    expect(res.status).toBe(200);
    const after = (await res.json()) as (Listed[number] & { uploaded: boolean })[];
    expect(after.map((u) => [u.name, u.uploaded, u.imported])).toEqual([["kokuhoren.UKE", false, false], ["shiharaikikin.UKE", false, false], [name, true, true]]);
    expect(after[2].receipts.map((x) => x.claimId)).toEqual([X1, X2]);
    expect(stored(owner)).toEqual([name]);
    // 同じものをもう一度送っても増えない
    expect((await r.upload(upload(cookie, bytes))).status).toBe(200);
    expect(stored(owner)).toHaveLength(1);

    const total = (k: string) => linesOf(k).reduce((s, l) => s + pointsOf(resolveRevision(YM), l.kubun)! * l.count, 0);
    const out = await instance.runAs(owner, () => {
      const a = instance.getApp();
      const me = instance.clerkIdOf(owner);
      expect(a.importedClaims(me)).toEqual([X1, X2]);
      // 事実は「不明」（年齢・保険種別だけは UKE から作った患者マスタで分かる）。出来事の記録はなく、施設は標準の設定
      const c = a.caseOf(X1);
      expect([c.facts.mainDisease.known, c.facts.residence.known, c.facts.age.known, c.facts.insurance, c.events, c.payer]).toEqual([false, false, true, { known: true, value: "後期高齢者" }, [], "国保連"]);
      expect(c.facility).toEqual(a.caseOf(claimId("K1")).facility);
      // 患者情報チェック（P 系）は、UKE の患者・保険の情報で動く
      expect(Array.isArray(a.patientProfile(X1).findings)).toBe(true);
      const judged = [X1, X2].map((id) => {
        const q = a.start(me, id);
        a.draft(q.id, a.caseFor(q).lines);
        return a.confirm(q.id, a.caseFor(q).lines);
      });
      // 対象外：訪問カルテ・選択モード。カルテを書く患者の一覧・訪問の記録には並ばない
      expect(() => a.saveNote(X1, me, "訪問診療", { s: "", o: "", a: "", p: "", rx: "" })).toThrow("訪問カルテの対象外");
      expect(() => a.start(me, X1, "選択")).toThrow("選択モードの対象外");
      expect(a.patients().some((p) => p.claimId === X1)).toBe(false);
      expect(a.visits(me).some((v) => v.claimId === X1 || v.claimId === X2)).toBe(false);
      expect(a.crosscheckOf(X1).mismatches).toEqual([]);
      return judged;
    });
    const [j1, j2] = out.map((q) => q.confirmed!.result);
    // 合計は出る（行の点数だけで決まる）
    expect([j1.total, j2.total]).toEqual([total("K2"), total("K5")]);
    // 指摘は情報不足だけ。記録がないと決められないルール（R14・R09）は、要件不足と決めつけず、情報不足として返す
    const missing = (f: { ruleId: string; kind: string; missing?: { target: string; field: string } }) => [f.ruleId, f.kind, f.missing?.target, f.missing?.field];
    expect(j1.findings.every((f) => f.kind === "情報不足")).toBe(true);
    expect(j1.findings.map(missing)).toEqual(expect.arrayContaining([["R02", "情報不足", "doctor", "table8_2"], ["R16", "情報不足", "clerk", "residence"], ["R14", "情報不足", "clerk", "chartRecord"]]));
    expect(j2.findings.map(missing)).toEqual([["R09", "情報不足", "clerk", "chartRecord"]]);
    // 項目名を借りていた visitsComplete は、どの指摘にも出ない（design.md §11-6）
    expect([...j1.findings, ...j2.findings].some((f) => f.missing?.field === "visitsComplete")).toBe(false);
    expect(out.map((q) => q.correct)).toEqual([true, true]);

    // すでに取り込んだ UKE と同じ請求 id で内容が違うものは断り、保存しない
    resetLimits();
    const again = await r.upload(upload(cookie, writeUke({ ...file, receipts: [{ ...file.receipts[0], patient: person(3, "架空 星子") }] })));
    expect([again.status, (await again.json()).error]).toEqual([400, expect.stringContaining("2 行目：すでに取り込んだ UKE と同じ請求 id で、内容が違う")]);
    expect(stored(owner)).toEqual([name]);
    // 架空コードの表にないコードを 1 行でも含めば、ファイルごと断る
    const unknownCode = await r.upload(upload(cookie, enc(textOf(writeUke({ ...file, receipts: [{ ...file.receipts[0], claimId: `X3-${YM}` }] })).replace(/^(SI,\d+,\d+,)\d+/m, "$1160000310"))));
    expect([unknownCode.status, (await unknownCode.json()).error]).toEqual([400, expect.stringContaining("架空コードの表にないコード")]);
    expect(stored(owner)).toEqual([name]);

    // ほかのクリニックには見えず、名前（ハッシュ）を知っていても取り込めない
    const stranger = auth().register("uke_owner_h", "さとう", "password123");
    expect(stored(stranger)).toEqual([]);
    const theirs = (await (await r.list(get("/api/uke", cookieOf(stranger)))).json()) as Listed;
    expect(theirs.map((u) => u.name)).toEqual(["kokuhoren.UKE", "shiharaikikin.UKE"]);
    await instance.runAs(stranger, () => {
      const a = instance.getApp();
      expect(a.cases().some((c) => c.claimId === X1)).toBe(false);
      expect(() => a.importUke(instance.clerkIdOf(stranger), name)).toThrow();
    });
    // 見本は、いままでどおり取り込める（受け取った UKE と並ぶ）
    resetLimits();
    expect((await r.upload(upload(cookie, sample("shiharaikikin.UKE")))).status).toBe(200);
    const all = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(all.filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual([claimId("K6"), X1, X2]);
    resetLimits();
  });

  it("上限を超える大きさは 413（本文を読み切る前に断る）。何も保存しない", async () => {
    const r = await routes();
    const owner = auth().register("uke_owner_d", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const res = await r.upload(upload(cookie, Buffer.alloc(UKE_LIMITS.maxBytes + 8192, 0x41)));
    expect(res.status).toBe(413);
    // content-length が上限を超えていれば、本文を読まずに断る
    const declared = new Request("http://localhost/api/uke/upload", { method: "POST", headers: { cookie, "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) }, body: "--x--\r\n" });
    expect((await r.upload(declared)).status).toBe(413);
    expect(stored(owner)).toEqual([]);
  });

  it("見本の UKE をダウンロードして、そのままアップロードすると、月末の点検の一覧に並ぶ。保存はクリニックの置き場に、内容のハッシュの名前で", async () => {
    const r = await routes();
    const owner = auth().register("uke_owner_e", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const before = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(before.map((u) => [u.name, u.imported])).toEqual([["kokuhoren.UKE", false], ["shiharaikikin.UKE", false]]);

    const down = await r.sample(get("/api/uke/sample?name=kokuhoren.UKE", cookie));
    expect([down.status, down.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="kokuhoren.UKE"']);
    const bytes = Buffer.from(await down.arrayBuffer());
    expect(bytes.equals(sample("kokuhoren.UKE"))).toBe(true);
    // 見本の一覧にない名前・パスを仕込んだ名前は取れない
    expect((await r.sample(get("/api/uke/sample?name=other.UKE", cookie))).status).toBe(404);
    expect((await r.sample(get(`/api/uke/sample?name=${encodeURIComponent("../../config/demo.json")}`, cookie))).status).toBe(400);

    // ファイル名にパスを仕込んでも、保存先には関係しない（名前は内容のハッシュ）
    const res = await r.upload(upload(cookie, bytes, "../../../evil.UKE"));
    expect(res.status).toBe(200);
    const after = (await res.json()) as Listed;
    expect(after.map((u) => [u.name, u.imported])).toEqual([["kokuhoren.UKE", true], ["shiharaikikin.UKE", false]]);
    // 月末の点検の一覧（算定画面が読むのは GET /api/uke の取り込み済みのレセプト）
    const list = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(list.filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId))).toEqual(["K1", "K2", "K3", "K4", "K5", "K7"].map(claimId));
    expect(stored(owner)).toEqual([`${createHash("sha256").update(bytes).digest("hex")}.UKE`]);
    expect(existsSync(path.join(tmp, "evil.UKE")) || existsSync(path.join(tmp, "..", "evil.UKE"))).toBe(false);
    // 同じものをもう一度送っても増えない。ほかのクリニックには見えない
    expect((await r.upload(upload(cookie, bytes))).status).toBe(200);
    expect(stored(owner)).toHaveLength(1);
    const stranger = auth().register("uke_owner_f", "さとう", "password123");
    expect(stored(stranger)).toEqual([]);
    expect(((await (await r.list(get("/api/uke", cookieOf(stranger)))).json()) as Listed).map((u) => u.imported)).toEqual([false, false]);
    // 監査ログに 1 行ずつ残る（本文・ファイル名は入れない）
    const log = await instance.runAs(owner, () => instance.getApp().audit.list());
    expect(JSON.stringify(log)).not.toMatch(/evil|架空/);
    expect(log.filter((l: { action: string }) => l.action === "POST /api/uke/upload")).toHaveLength(2);
  });
});
