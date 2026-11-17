// UKE のアップロードと見本のダウンロード（spec FR-106〜109）。実際のルート（app/api/uke/**/route.ts）を呼んで確かめる
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { UKE_LIMITS } from "../../src/uke/limits";
import { claimId } from "../helpers/period";

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

  it("形式は正しくても、同梱の症例にない請求 id・見本と違う内容は断る（仮置き：点検に並べられるのは見本と同じ内容だけ）", async () => {
    const r = await routes();
    const owner = auth().register("uke_owner_c", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const text = textOf(sample("shiharaikikin.UKE"));
    const other = await r.upload(upload(cookie, enc(text.replace(claimId("K6"), claimId("K99")))));
    expect([other.status, (await other.json()).error]).toEqual([400, "この UKE は取り込めません（2 行目：同梱の症例にない請求 id）"]);
    const changed = await r.upload(upload(cookie, enc(text.replace("架空在宅クリニック", "架空在宅診療所"))));
    expect([changed.status, (await changed.json()).error]).toEqual([400, expect.stringContaining("見本と内容が違う")]);
    expect(stored(owner)).toEqual([]);
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
