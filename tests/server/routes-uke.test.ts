// UKE のアップロードと見本のダウンロード（spec FR-106〜109）、取り込んだレセプトの点検（design.md §11-11）、版のない診療年月のレセプトと試算（§11-12）。実際のルート（app/api/uke/**/route.ts）を呼んで確かめる
import Database from "better-sqlite3";
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";
import type { Role } from "../../src/server/roles";
import { pointsOf, resolveRevision, UKE_TRIAL_REVISIONS } from "../../src/engine/revisions";
import type { EngineResult } from "../../src/engine/types";
import type { Notice } from "../../src/notice/notice";
import type { Question } from "../../src/practice/practice";
import { UKE_CLAIM_ID, UKE_LIMITS } from "../../src/uke/limits";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { claimId, month, YM } from "../helpers/period";
import { autoConsent } from "../helpers/consent";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-routes-uke-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  delete process.env.RESEMEN_OPEN_SIGNUP;
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
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
/** 取り込んだレセプトの点検（GET /api/uke/claims/[claimId]/check） */
const check = async (id: string, cookie: string | null) =>
  (await import("../../app/api/uke/claims/[claimId]/check/route")).GET(get(`/api/uke/claims/${encodeURIComponent(id)}/check`, cookie), { params: Promise.resolve({ claimId: id }) });
const sample = (name: string) => readFileSync(path.join(repo, "fixtures", "uke", name));
const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
const textOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1));
/** そのクリニックの、アップロードした UKE の置き場にあるファイル */
const stored = (u: User): string[] => {
  const dir = path.join(path.dirname(instance.tenantPaths(u.tenantId).dbFile), "uke");
  return existsSync(dir) ? readdirSync(dir) : [];
};
type Listed = {
  name: string;
  uploaded: boolean;
  imported: boolean;
  unreadable: { reason: string } | null;
  receipts: { claimId: string; patient: string; patientNo: string | null; sameMonth: boolean; otherRows: number; unreadable: string | null; revisionId: string | null }[];
}[];

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
    /** 見本（K6）の行：1 IR・2 RE・3 HO・4 SN・5 JD・6 MF・7 SY・8 SI・9 SI・10 GO */
    const broken: [string, Buffer, string][] = [
      ["列数の不足", enc(text.replace(/^(SI,.*),\r\n/m, "$1\r\n")), "8 行目：列数が合わない"],
      ["範囲外の数値", withCell(8, 6, "0"), "8 行目：回数が範囲の外"],
      ["版の点数表と合わない点数", withCell(8, 5, "131"), "8 行目：点数が診療年月の版の点数表と合わない"],
      ["上限を超える日別回数", withCell(8, 13, "999999999"), "8 行目：1 日の回数が上限を超えている"],
      ["最後のレコードが CRLF で終わらない", Buffer.concat([sample("shiharaikikin.UKE").subarray(0, -3), Buffer.from([0x1a])]), "最後のレコードが CRLF で終わっていない"],
      ["UKE でないバイト列", Buffer.from("%PDF-1.7\n".repeat(20)), "最後のレコードが CRLF で終わっていない"],
    ];
    const { resetLimits, limits } = await import("../../src/server/rate-limit");
    for (const [what, bytes, reason] of broken) {
      // 回数制限（1 分あたり）に当たらないよう、数え直す。回数制限そのものは下で確かめる
      resetLimits();
      const res = await r.upload(upload(cookie, bytes));
      const body = await res.text();
      expect([what, res.status, JSON.parse(body).error]).toEqual([what, 400, `この UKE は取り込めません（${reason}）`]);
      expect(body).not.toMatch(/六郎|01139997|999999999|PDF|131/);
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

  it("請求 id はアプリが振る（U<取り込みの連番>-<通し番号>）。カルテ番号が同梱の症例の番号と同じでも、症例には結びつかない。請求 id に使えない文字のカルテ番号も、患者の番号として受け取る", async () => {
    expect(["U1-1", "U12-3", "U123456-999"].every((id) => UKE_CLAIM_ID.test(id))).toBe(true);
    const r = await routes();
    const owner = auth().register("uke_owner_c", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const text = textOf(sample("shiharaikikin.UKE"));
    // 見本と内容が違う（医療機関の名前だけ違う）ファイル：カルテ番号は見本と同じ K6 の番号
    const changed = await r.upload(upload(cookie, enc(text.replace("架空在宅クリニック", "架空在宅診療所"))));
    expect(changed.status).toBe(200);
    const first = ((await changed.json()) as Listed).filter((u) => u.uploaded);
    expect(first.map((u) => u.receipts.map((x) => [x.claimId, x.patientNo]))).toEqual([[["U1-1", claimId("K6")]]]);
    // パスの形をしたカルテ番号も、表示にだけ使う値として受け取る（請求 id にも保存先にも使わない）
    const odd = await r.upload(upload(cookie, enc(text.replace(claimId("K6"), "../../etc/passwd").replace("架空在宅クリニック", "架空在宅医院"))));
    expect(odd.status).toBe(200);
    const list = ((await odd.json()) as Listed).filter((u) => u.uploaded);
    expect(list.map((u) => u.receipts.map((x) => [x.claimId, x.patientNo]))).toEqual([[["U1-1", claimId("K6")]], [["U2-1", "../../etc/passwd"]]]);
    expect(stored(owner).every((n) => /^[0-9a-f]{64}\.UKE$/.test(n))).toBe(true);
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      // 取り込んだ請求は、症例（K6）の事実を持たない。見本の K6 は取り込んでいない
      expect(a.importedClaims(instance.clerkIdOf(owner))).toEqual(["U1-1", "U2-1"]);
      expect([a.caseOf("U1-1").recordsKnown, a.caseOf("U1-1").facts.mainDisease.known, a.caseOf(claimId("K6")).recordsKnown]).toEqual([false, false, true]);
    });
    // 同じ内容の 3 つのファイルは、同じ患者・同じ月・同じレセプト種別なので、断らずに全部に知らせる（見本にも）
    const all = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(all.map((u) => [u.name.length === 68 ? "upload" : u.name, u.receipts.map((x) => x.sameMonth)])).toEqual([["kokuhoren.UKE", [false, false, false, false, false, false]], ["shiharaikikin.UKE", [true]], ["upload", [true]], ["upload", [true]]]);
  });

  it("同じ患者の 2 か月分・同じ患者のレセプトが 2 枚あるファイル・カルテ番号が空のファイルを取り込める。断るのは同じファイルの取り込み直しだけ（完了条件 (g)）", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_owner_i", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const base = readUke(sample("shiharaikikin.UKE"));
    const k6 = base.receipts[0];
    const person: UkePatient = { ...k6.patient, name: "架空 梅子", birth: "19500606", insurer: { number: "06139991", symbol: "12", no: "345" } };
    const next = month(1);
    const inMonth = (ym: string) => k6.lines.map((l) => ({ ...l, dates: l.dates.map((d) => `${ym}${d.slice(7)}`) }));
    const receipt = (chartNo: string, ym: string) => ({ claimId: chartNo, yearMonth: ym, patient: person, lines: inMonth(ym), comments: [], commentsKnown: true });
    const send = async (file: UkeFile) => {
      resetLimits();
      const res = await r.upload(upload(cookie, writeUke(file)));
      return { status: res.status, body: (await res.json()) as Listed & { error?: string } };
    };
    const mine = (l: Listed) => l.filter((u) => u.uploaded).map((u) => u.receipts.map((x) => [x.claimId, x.patientNo, x.sameMonth]));

    // 1 つ目：今月分。カルテ番号は患者の番号（P77）
    const a = await send({ ...base, receipts: [receipt("P77", YM)] });
    expect([a.status, mine(a.body)]).toEqual([200, [[["U1-1", "P77", false]]]]);
    // 2 つ目：同じ患者（同じカルテ番号）の翌月分。請求 id が重ならないので受け取る
    const b = await send({ ...base, billingMonth: month(2), receipts: [receipt("P77", next)] });
    expect([b.status, mine(b.body)]).toEqual([200, [[["U1-1", "P77", false]], [["U2-1", "P77", false]]]]);
    // 3 つ目：同じ患者のレセプトが 2 枚（同じカルテ番号）と、カルテ番号が空のレセプト。今月分は 1 つ目と同じ月なので、両方に知らせる
    const c = await send({ ...base, receipts: [receipt("P77", YM), { ...receipt("P77", YM), patient: { ...person, receiptType: "1112" } }, { ...receipt("", YM), patient: { ...person, name: "架空 桃子", birth: "19510707", insurer: { ...person.insurer, no: "346" } } }] });
    expect(c.status).toBe(200);
    expect(mine(c.body)).toEqual([[["U1-1", "P77", true]], [["U2-1", "P77", false]], [["U3-1", "P77", true], ["U3-2", "P77", false], ["U3-3", "", false]]]);
    // 同じファイルの取り込み直しは断る（増えない。連番も進まない）
    const again = await send({ ...base, receipts: [receipt("P77", YM)] });
    expect([again.status, again.body.error]).toEqual([400, expect.stringContaining("同じファイルをすでに取り込んでいます")]);
    expect(stored(owner)).toHaveLength(3);
    // 断られたファイル（壊れた UKE）でも連番は進まない
    expect((await r.upload(upload(cookie, Buffer.from("x")))).status).toBe(400);
    const d = await send({ ...base, receipts: [{ ...receipt("P78", YM), patient: { ...person, name: "架空 桜子" } }] });
    expect(mine(d.body).at(-1)).toEqual([["U4-1", "P78", false]]);

    await instance.runAs(owner, () => {
      const app = instance.getApp();
      // 同じ患者の請求は、患者マスタでは 1 人に寄る（請求はファイルごとに別）
      expect(new Set(["U1-1", "U2-1", "U3-1", "U3-2"].map((id) => app.patientFacts(id).patientId)).size).toBe(1);
      expect(app.patientFacts("U3-3").patientId).not.toBe(app.patientFacts("U1-1").patientId);
      expect([app.caseOf("U2-1").yearMonth, app.caseOf("U1-1").yearMonth]).toEqual([next, YM]);
      // 読み直しても（キャッシュを捨てても）同じ id になる：一覧に連番を保存している
      expect(JSON.parse(app.setting("uke-uploads")!)).toMatchObject({ next: 5, files: [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }] });
    });
  });

  it("見本と違う内容の UKE（同梱の症例にない患者・請求 id、複数レセプト）を受け取り、月末の点検に並べる。足りない事実は情報不足として出て、合計は出る", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_owner_g", "やまだ", "password123");
    const cookie = cookieOf(owner);
    // 見本のレセプトの行を借りて、架空の患者・別の請求 id のレセプトを 2 件作る（コードは版のコードの表のもの）
    const base = readUke(sample("kokuhoren.UKE"));
    const linesOf = (k: string) => base.receipts.find((x) => x.claimId === claimId(k))!.lines;
    const person = (n: number, name: string): UkePatient => ({ name, sex: 2, birth: "19440505", receiptType: "1318", insurer: { number: "39139993", symbol: "", no: `0000009${n}` }, kohi: [], diseases: [{ name: "慢性心不全", start: "20250401", main: true }] });
    // 請求 id はアプリが振る（UKE のカルテ番号は X1・X2 のまま、患者の番号として残る）
    const X1 = "U1-1";
    const X2 = "U1-2";
    const file: UkeFile = {
      ...base,
      receipts: [
        // 在宅移行早期加算（退院・算定開始月の記録がないと決められない）を含む行
        { claimId: `X1-${YM}`, yearMonth: YM, patient: person(1, "架空 花子"), lines: linesOf("K2"), comments: [], commentsKnown: true },
        // ターミナルケア加算（訪問の記録がないと決められない）を含む行
        { claimId: `X2-${YM}`, yearMonth: YM, patient: person(2, "架空 月子"), lines: linesOf("K5"), comments: [], commentsKnown: true },
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
    // 同じものをもう一度送ると断る（増えない）
    expect((await r.upload(upload(cookie, bytes))).status).toBe(400);
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
    expect(j1.findings.map(missing)).toEqual(expect.arrayContaining([["R02", "情報不足", "doctor", "table8_2"], ["R16", "情報不足", "clerk", "residenceType"], ["R14", "情報不足", "clerk", "chartRecord"]]));
    expect(j2.findings.map(missing)).toEqual([["R09", "情報不足", "clerk", "chartRecord"]]);
    // 項目名を借りていた visitsComplete は、どの指摘にも出ない（design.md §11-6）
    expect([...j1.findings, ...j2.findings].some((f) => f.missing?.field === "visitsComplete")).toBe(false);
    expect(out.map((q) => q.correct)).toEqual([true, true]);

    // 対応しているコードの点数が版の点数表と合わなければ、今までどおりファイルごと断る（対応していないコードの行は断らない。下の「取り込んだレセプトの点検」）
    const wrongPoints = await r.upload(upload(cookie, enc(textOf(writeUke({ ...file, receipts: [{ ...file.receipts[0], claimId: `X3-${YM}` }] })).replace(/^(SI,\d+,\d+,\d+,,)890,/m, "$1891,"))));
    expect([wrongPoints.status, (await wrongPoints.json()).error]).toEqual([400, expect.stringContaining("点数が診療年月の版の点数表と合わない")]);
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

describe("取り込んだレセプトの点検（GET /api/uke/claims/[claimId]/check。design.md §11-11 完了条件 (f)）", () => {
  type Check = {
    claimId: string;
    yearMonth: string;
    patient: string;
    patientNo: string | null;
    unreadable: { reason: string } | null;
    declared: { ho: number | null; ko: number[] };
    lines: { kubun: string; name: string; count: number; dates: string[]; points: number | null }[];
    subtotal: number | null;
    others: { codes: string[]; points: number | null; count: number; dates: string[] }[];
    otherRows: number;
    partial: boolean;
    recordsKnown: boolean;
    commentsKnown: boolean;
    findings: { ruleId: string; kind: string; messageKey: string; params?: Record<string, string>; lineRefs: string[] }[];
    commentMissingCount: number;
    missing: { ruleId: string; kind: string; missing?: { target: string; field: string } }[];
    comments: { code: string; text: string }[];
    patientFindings: unknown[];
  };
  const sumOf = (c: Check) => c.lines.reduce((s, l) => s + (l.points ?? 0) * l.count, 0);

  it("未ログインは 401、医師の役割は 403、一覧にないレセプトは 404。形の違う id は 400", async () => {
    const owner = auth().register("uke_check_a", "やまだ", "password123");
    const cookie = cookieOf(owner);
    expect((await check(claimId("K1"), null)).status).toBe(401);
    expect((await check("U9-9", cookie)).status).toBe(404);
    expect((await check("../x", cookie)).status).toBe(400);
    expect((await check(claimId("K1"), cookie)).status).toBe(200);
    // 事務長は見られる（一覧と同じ役割）。医師は見られない
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    expect((await check(claimId("K1"), cookie)).status).toBe(200);
    expect((await switchTo(cookie, "doctor")).status).toBe(200);
    expect((await check(claimId("K1"), cookie)).status).toBe(403);
  });

  it("対象外の行がある合成の UKE：断らずに取り込み、対象外の行の件数・点検した行の小計・UKE の合計を別々に返す。指摘は申告のある種類だけで、合計を小計で代用しない", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_check_b", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const up = await r.upload(upload(cookie, sample("taishogai.UKE")));
    expect(up.status).toBe(200);
    const listed = ((await up.json()) as Listed).filter((u) => u.uploaded);
    expect(listed.map((u) => [u.imported, u.unreadable, u.receipts.map((x) => [x.claimId, x.patientNo, x.otherRows, x.unreadable])])).toEqual([[true, null, [["U1-1", "100021", 2, null]]]]);
    const res = await check("U1-1", cookie);
    expect(res.status).toBe(200);
    const c = (await res.json()) as Check;
    expect([c.claimId, c.yearMonth, c.patientNo, c.unreadable, c.partial, c.recordsKnown, c.commentsKnown]).toEqual(["U1-1", YM, "100021", null, true, false, true]);
    // 対象外の単位は 1 つ（往診料と、扱っていない加算の 2 行）。コード・点数・回数・日は UKE に書いてあるまま
    expect(c.others).toEqual([{ codes: ["114000110", "114704470"], points: 1045, count: 1, dates: [`${YM}-20`] }]);
    expect(c.otherRows).toBe(2);
    // 全部の単位（引けた単位も対象外の単位も）が UKE の並びで 1 つに並び、単位ごとに見た点検が付く。データで動く点検は、動いたとき（マスターがあるとき）だけ全部の単位を見る
    const ran = (c as Check & { generic: { ran: unknown[] } }).generic.ran.length > 0;
    const rows = (c as Check & { rows: { unit: number; items: { code: string }[]; kubun: string[]; points: number; count: number; checkedBy: string }[] }).rows;
    expect(rows.map((x) => x.unit)).toEqual(rows.map((_, i) => i));
    const other = rows.filter((x) => x.kubun.length === 0);
    expect(other.map((x) => [x.items.map((it) => it.code), x.points, x.checkedBy])).toEqual([[["114000110", "114704470"], 1045, ran ? "generic" : "none"]]);
    expect(rows.filter((x) => x.kubun.length > 0).every((x) => x.checkedBy === (ran ? "rules+generic" : "rules"))).toBe(true);
    expect(rows.reduce((s, x) => s + x.points * x.count, 0)).toBe(c.declared.ho);
    // 合計は 2 つ：UKE に書いてある請求の合計と、点検した行の小計。小計＋対象外の単位＝UKE の合計
    expect(c.subtotal).toBe(sumOf(c));
    expect(c.declared).toEqual({ ho: (c.subtotal as number) + 1045, ko: [] });
    expect(c.lines.some((l) => l.kubun === "C000")).toBe(false);
    expect(c.lines[0]).toEqual({ kubun: "C001_1I", no: expect.any(String), name: expect.stringContaining("訪問診療料"), count: 2, dates: [`${YM}-14`, `${YM}-28`], points: 890 });
    // 指摘は出ない（訪問日の記載と往診の日の食い違いは、往診料の行が対象外にあるので比べない）。足りない事実は情報不足として出る
    expect(c.findings).toEqual([]);
    expect(c.commentMissingCount).toBe(0);
    expect(c.missing.length).toBeGreaterThan(0);
    expect(c.missing.every((m) => m.kind === "情報不足")).toBe(true);
    expect(c.comments.map((x) => x.code)).toEqual(expect.arrayContaining(["850100106", "850100108"]));
    expect(Array.isArray(c.patientFindings)).toBe(true);
    // 月末の点検（利用者が行を入力する問題）でも、合計は出さない
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      const me = instance.clerkIdOf(owner);
      expect(a.caseOf("U1-1").partial).toBe(true);
      const q = a.start(me, "U1-1");
      const result = a.confirm(q.id, a.caseFor(q).lines).confirmed!.result;
      expect([result.total, result.subtotal]).toEqual([null, c.subtotal]);
    });
  });

  it("実在の形の検証用の合成の UKE（jitsurei.UKE。医薬品・特定器材・症状詳記・資格確認・受診日等を含む 4 件）：取り込みのルートで受け取れ、4 件とも点検が 200 を返す。対象外の単位は、回数ぶんの日付に広げない", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_check_j", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const up = await r.upload(upload(cookie, sample("jitsurei.UKE")));
    expect(up.status).toBe(200);
    const listed = ((await up.json()) as Listed).filter((u) => u.uploaded);
    expect(listed.map((u) => [u.imported, u.unreadable, u.receipts.map((x) => [x.claimId, x.patientNo, x.otherRows, x.unreadable, x.revisionId !== null])])).toEqual([
      [true, null, [["U1-1", "200011", 8, null, true], ["U1-2", "200012", 13, null, true], ["U1-3", "200013", 14, null, true], ["U1-4", "200014", 2, null, true]]],
    ]);
    const checks: Check[] = [];
    for (const id of ["U1-1", "U1-2", "U1-3", "U1-4"]) {
      const res = await check(id, cookie);
      expect([id, res.status]).toEqual([id, 200]);
      checks.push((await res.json()) as Check);
    }
    expect(checks.map((c) => [c.unreadable, c.partial, c.declared.ho, c.lines.map((l) => l.kubun), c.others.length, c.subtotal])).toEqual([
      [null, true, 845, ["A001", "D007_5", "D005_5", "D026_3", "D026_4"], 7, 152 + 93 + 21 + 125 + 144],
      [null, true, 919, ["A001"], 8, 76],
      [null, true, 744, ["A001"], 8, 76],
      [null, true, 8350, ["C001_1I", "C103_2", "F400_3"], 2, 1780 + 2400 + 120],
    ]);
    // 減点の単位（U1-3 の薬剤料逓減 630010002）だけが deduction を持つ。点数は UKE のまま正の数
    const rowsOf = (c: Check) => (c as Check & { rows: { items: { code: string }[]; points: number; deduction: boolean }[] }).rows;
    expect(checks.map((c) => rowsOf(c).filter((x) => x.deduction).map((x) => [x.items.map((it) => it.code), x.points]))).toEqual([[], [], [[["630010002"], 67]], []]);
    // 14 日分を 2 回処方した内服薬の単位：回数は 28、日は処方した 2 日だけ（回数ぶんに重ねない）
    expect(checks[0].others[1]).toEqual({ codes: ["620491801", "610463223"], points: 1, count: 28, dates: [`${YM}-15`, `${YM}-29`] });
    // 対象外の単位があるので、合計は出さない（月末の点検でも同じ）。4 件とも月末の点検に並ぶ
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      expect(["U1-1", "U1-2", "U1-3", "U1-4"].map((id) => a.caseOf(id).partial)).toEqual([true, true, true, true]);
    });
  });

  it("必須の記載を 1 つ欠いた合成の UKE：記載もれの指摘が 1 件出て、件数に数える。対象外の行はなく、小計は UKE の合計と同じ", async () => {
    const r = await routes();
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register("uke_check_c", "やまだ", "password123");
    const cookie = cookieOf(owner);
    expect((await r.upload(upload(cookie, sample("kisaimore.UKE")))).status).toBe(200);
    const c = (await (await check("U1-1", cookie)).json()) as Check;
    expect([c.partial, c.otherRows, c.others, c.subtotal, c.declared.ho]).toEqual([false, 0, [], 14806, 14806]);
    expect(c.findings.map((f) => [f.ruleId, f.kind, f.messageKey, f.params?.rule, f.lineRefs])).toEqual([["R17", "記載もれ", "R17.comment_missing", "T216-spo2", ["C103_2"]]]);
    expect(c.commentMissingCount).toBe(1);
    // コメントは UKE に書いてあるまま（文字データは原文＝全角）
    expect(c.comments).toEqual([{ code: "850100106", text: "５０８１０１４" }, { code: "850100106", text: "５０８１０２８" }]);
  });

  it("同梱の見本から取り込んだレセプトも、UKE に書いてあるとおりのまま点検する（カルテ側の記録は使わない）。月末の点検の判定（コメントを見ない）は今のまま", async () => {
    const owner = auth().register("uke_check_d", "やまだ", "password123");
    const cookie = cookieOf(owner);
    const c = (await (await check(claimId("K5"), cookie)).json()) as Check;
    expect([c.partial, c.recordsKnown, c.commentsKnown, c.patientNo, c.declared.ho, c.subtotal]).toEqual([false, false, true, null, 10175, 10175]);
    // 必須の記載は付いているので、記載もれは 0 件。記録を読む点検（ターミナルケア加算の訪問の回数）は、していないと返す
    expect([c.findings, c.commentMissingCount]).toEqual([[], 0]);
    expect(c.missing.map((m) => [m.ruleId, m.missing?.field])).toContainEqual(["R09", "chartRecord"]);
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      const q = a.start(instance.clerkIdOf(owner), claimId("K5"));
      expect([a.caseFor(q).commentsKnown, a.caseFor(q).partial]).toEqual([false, undefined]);
    });
  });

  it("保存済みのレセプトが、あとから表と合わなくなっても、一覧とほかのレセプトは動き、そのレセプトにだけ理由が出る（design.md §11-12 完了条件 (f)）", async () => {
    const r = await routes();
    const owner = auth().register("uke_check_e", "やまだ", "password123");
    const cookie = cookieOf(owner);
    // 取り込んだ後に点数表が変わった、と見立てる：保存済みのファイルの 2 件目のレセプトで、対応しているコードの点数がいまの版と合わない
    // （取り込みでは断られる内容なので、置き場と取り込みの一覧に直接置く）
    const base = readUke(sample("shiharaikikin.UKE"));
    const person = (name: string, no: string): UkePatient => ({ ...base.receipts[0].patient, name, birth: "19520303", insurer: { number: "06139991", symbol: "7", no } });
    const two = textOf(writeUke({ ...base, receipts: [{ ...base.receipts[0], claimId: "A1", patient: person("架空 松子", "801") }, { ...base.receipts[0], claimId: "A2", patient: person("架空 竹子", "802") }] }));
    // 2 件目の BNP の点数（130）と、その HO・GO の合計を 1 点ずらす
    const rows = two.split("\r\n");
    const second = rows.findIndex((l, i) => l.startsWith("RE,") && i > 1);
    const bump = (i: number, col: number) => (rows[i] = rows[i].split(",").map((v, n) => (n === col ? String(Number(v) + 1) : v)).join(","));
    bump(second + 1, 5);
    bump(rows.findIndex((l, i) => i > second && l.startsWith("SI,")), 5);
    bump(rows.findIndex((l) => l.startsWith("GO,")), 2);
    const bytes = enc(rows.join("\r\n"));
    expect((await r.upload(upload(cookie, bytes))).status).toBe(400);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = path.join(path.dirname(instance.tenantPaths(owner.tenantId).dbFile), "uke");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sha256}.UKE`), bytes);
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      a.setSetting("uke-uploads", JSON.stringify({ next: 2, files: [{ seq: 1, sha256 }] }));
      a.importUke(instance.clerkIdOf(owner), `${sha256}.UKE`);
    });
    const reason = "取り込んだ後に表が変わり、点数が合わなくなりました";
    const list = (await (await r.list(get("/api/uke", cookie))).json()) as Listed;
    expect(list.map((u) => [u.unreadable, u.receipts.map((x) => [x.claimId, x.unreadable])])).toEqual([
      [null, ["K1", "K2", "K3", "K4", "K5", "K7"].map((k) => [claimId(k), null])],
      [null, [[claimId("K6"), null]]],
      [null, [["U1-1", null], ["U1-2", reason]]],
    ]);
    // 読めなかったレセプトの点検は、理由だけを返す。同じファイルのもう 1 件と、見本は今までどおり
    const bad = await check("U1-2", cookie);
    expect([bad.status, await bad.json()]).toEqual([200, { claimId: "U1-2", yearMonth: YM, patient: "架空 竹子", patientNo: "A2", unreadable: { reason } }]);
    const ok = (await (await check("U1-1", cookie)).json()) as Check;
    expect([ok.unreadable, ok.declared.ho, ok.subtotal]).toEqual([null, 274, 274]);
    await instance.runAs(owner, () => {
      const a = instance.getApp();
      // 月末の点検には、読めたレセプトだけが並ぶ。症例の一覧も止まらない
      expect(a.importedClaims(instance.clerkIdOf(owner))).toEqual(["U1-1"]);
      expect(a.cases().map((x) => x.claimId)).toEqual([...["K1", "K2", "K3", "K4", "K5", "K7", "K6"].map(claimId), "U1-1"]);
      expect(() => a.caseOf("U1-2")).toThrow();
    });
    // 事務長は、読めないレセプトを含むファイルも消せる
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    const del = await (await import("../../app/api/uke/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/uke/uploads/${sha256}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ sha256 }) });
    expect([del.status, await del.json()]).toEqual([200, { deleted: sha256, claims: 2 }]);
    expect(stored(owner)).toEqual([]);
  });
});

describe("版のない診療年月のレセプトと試算（GET /api/uke/claims/[claimId]/trial。design.md §11-12 完了条件 (a)(b)(e)）", () => {
  type Check = { claimId: string; yearMonth: string; patientNo: string | null; unreadable: null; revisionId: string | null; revisions: { id: string; label: string }[]; subtotal?: number | null; findings?: unknown[]; missing?: unknown[]; lines?: unknown[]; declared?: unknown; comments?: unknown[] };
  type Trial = {
    claimId: string;
    yearMonth: string;
    patientNo: string | null;
    total: number | null;
    trial: { revisionId: string; claimYearMonth: string; inPeriod: boolean };
    rulesAvailable: boolean;
    ownRevisionId: string | null;
    revisionLabel: string;
    revisions: { id: string; label: string }[];
    declared: { ho: number | null; ko: number[] };
    lines: { kubun: string; name: string; count: number; dates: string[]; points: number | null }[];
    subtotal: number | null;
    others: unknown[];
    partial: boolean;
    pointDiffs: { kubun: string[]; name: string; ukePoints: number; revPoints: number; count: number }[];
    findings: { ruleId: string; kind: string; messageKey: string; params?: Record<string, string> }[];
    commentMissingCount: number;
    missing: { kind: string }[];
    comments: unknown[];
  };
  const trialOf = async (id: string, rev: string | null, cookie: string | null) =>
    (await import("../../app/api/uke/claims/[claimId]/trial/route")).GET(get(`/api/uke/claims/${encodeURIComponent(id)}/trial${rev === null ? "" : `?rev=${rev}`}`, cookie), { params: Promise.resolve({ claimId: id }) });
  /** 改定前の診療年月の合成の UKE（EM 5-1。診療年月は基準月の 7 か月前） */
  const OLD = month(-7);
  const KS = ["K1", "K2", "K3", "K4", "K5", "K7", "K6"].map(claimId);
  const [r2026, latest] = [resolveRevision(YM), UKE_TRIAL_REVISIONS.at(-1)!];
  const noticeOf = () => JSON.parse(readFileSync(path.join(repo, "fixtures", "notices", "K6-2026-09-satei.json"), "utf8")) as Notice;
  /** DB の全表の中身（監査ログを除く） */
  const dump = (u: User): Record<string, string> => {
    const db = new Database(instance.tenantPaths(u.tenantId).dbFile, { readonly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name).filter((t) => t !== "audit_log");
      return Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())]));
    } finally {
      db.close();
    }
  };
  const start = async (login: string) => {
    const { resetLimits } = await import("../../src/server/rate-limit");
    resetLimits();
    const owner = auth().register(login, "やまだ", "password123");
    return { owner, cookie: cookieOf(owner), me: instance.clerkIdOf(owner), r: await routes() };
  };

  it("(a) 版のない診療年月の UKE が 1 件入っていても、請求の一覧・K1〜K7 の点検・通知の対応づけ・防いだ額・会議の整理が今までどおり動く。その請求は、月末の点検・提出に並ばない", async () => {
    const { owner, cookie, me, r } = await start("uke_trial_a");
    const casesRoute = (await import("../../app/api/cases/route")).GET;
    const snapshot = async () => ({
      checks: await Promise.all(KS.map(async (id) => (await check(id, cookie)).json())),
      cases: await (await casesRoute(get("/api/cases", cookie))).json(),
      notice: instance.runAs(owner, () => instance.getApp().resolveNoticeItems(noticeOf())),
    });
    const before = await snapshot();
    expect((before.cases as { claimId: string }[]).map((c) => c.claimId)).toEqual(KS);

    // 取り込みで断らない。一覧には、版がない（revisionId が null）として出る。読めないレセプト（unreadable）ではない
    const up = await r.upload(upload(cookie, sample("kaiteimae.UKE")));
    expect(up.status).toBe(200);
    const list = (await up.json()) as Listed;
    expect(list.map((u) => [u.uploaded, u.imported, u.unreadable, u.receipts.map((x) => [x.claimId, x.revisionId, x.unreadable, x.patientNo])])).toEqual([
      [false, false, null, KS.slice(0, 6).map((id) => [id, r2026.id, null, null])],
      [false, false, null, [[KS[6], r2026.id, null, null]]],
      [true, true, null, [["U1-1", null, null, "100022"]]],
    ]);
    expect(await (await (await r.list(get("/api/uke", cookie))).json())).toEqual(list);

    // 請求の一覧・K1〜K7 の点検（合計を含む）・通知の対応づけは、取り込む前と同じ
    expect(await snapshot()).toEqual(before);
    expect((before.checks as Check[]).map((c) => c.subtotal)).toEqual(KS.map((id) => (id === claimId("K6") ? 274 : expect.any(Number))));
    expect(before.notice).toMatchObject([{ claimId: claimId("K6"), problems: [] }]);

    // その請求の点検は、版がないことだけを返す（近い版で点検しない）。選べる版に、令和6年度の版はない
    const c = (await (await check("U1-1", cookie)).json()) as Check;
    expect(c).toEqual({ claimId: "U1-1", yearMonth: OLD, patient: "架空　敏子", patientNo: "100022", unreadable: null, revisionId: null, revisions: UKE_TRIAL_REVISIONS.map((x) => ({ id: x.id, label: x.label, own: false })) });

    await instance.runAs(owner, async () => {
      const a = instance.getApp();
      // 月末の点検（行を入力する問題）に並ばない。問題を作れないので、提出を確定できない
      expect(a.importedClaims(me)).toEqual([]);
      for (const name of ["kokuhoren.UKE", "shiharaikikin.UKE"]) a.importUke(me, name);
      expect(a.importedClaims(me)).toEqual(KS);
      expect(() => a.caseOf("U1-1")).toThrow(/症例がない/);
      expect(() => a.start(me, "U1-1")).toThrow(/症例がない/);
      expect(() => a.patientProfile("U1-1")).toThrow();
      expect(a.patients().map((p) => p.claimId)).not.toContain("U1-1");
      // 見本の請求は、今までどおり確定でき、提出結果の取り込み・会議の整理・防いだ額が動く
      const q = a.start(me, claimId("K1"));
      const lines = a.caseFor(q).lines;
      expect(a.confirm(q.id, lines).confirmed?.result.total).toBe(14806);
      a.importClaimResult({ resultId: "r-trial-a", submissionId: q.id, kind: "原審査", outcome: "通過", kubun: [] });
      expect(() => a.runMeeting()).not.toThrow();
      expect(Array.isArray(a.agenda().items)).toBe(true);
      expect(() => [a.personal(me, true), a.manager()]).not.toThrow();
    });
    // DB のどの表にも、その請求の id は入っていない（問題・提出・適用記録を作っていない）。取り込みの一覧（app_settings）は連番とハッシュだけ
    expect(Object.entries(dump(owner)).filter(([, rows]) => /U1-1/.test(rows)).map(([t]) => t)).toEqual([]);

    // 試算を開いたあとでも、事務長がファイルごと消せて、その患者はどの表にも残らない
    expect((await trialOf("U1-1", latest.id, cookie)).status).toBe(200);
    expect(JSON.stringify(dump(owner))).toMatch(/敏子/);
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    const sha256 = createHash("sha256").update(sample("kaiteimae.UKE")).digest("hex");
    const del = await (await import("../../app/api/uke/uploads/[sha256]/route")).DELETE(new Request(`http://localhost/api/uke/uploads/${sha256}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ sha256 }) });
    expect([del.status, await del.json()]).toEqual([200, { deleted: sha256, claims: 1 }]);
    expect(JSON.stringify(dump(owner))).not.toMatch(/敏子|100022|00000022/);
    expect(stored(owner)).toEqual([]);
  });

  it("(b) その UKE を最新の版で試算すると、UKE の点数とその版の点数の違いが並ぶ。行と小計はその版の点数で、UKE の合計は書いてあるまま。何も保存しない", async () => {
    const { owner, cookie, r } = await start("uke_trial_b");
    expect((await r.upload(upload(cookie, sample("kaiteimae.UKE")))).status).toBe(200);
    // 1 回目の試算で患者マスタに患者が入る（ほかの取り込んだレセプトと同じ扱い）。それより後は、試算で DB は変わらない
    expect((await trialOf("U1-1", latest.id, cookie)).status).toBe(200);
    const before = dump(owner);

    const res = await trialOf("U1-1", latest.id, cookie);
    expect(res.status).toBe(200);
    const t = (await res.json()) as Trial;
    expect([t.claimId, t.yearMonth, t.patientNo, t.ownRevisionId, t.revisionLabel]).toEqual(["U1-1", OLD, "100022", null, latest.label]);
    expect(t.trial).toEqual({ revisionId: latest.id, claimYearMonth: OLD, inPeriod: false });
    expect(t.rulesAvailable).toBe(true);
    expect(t.pointDiffs).toEqual([
      { kubun: ["C001_1I"], name: expect.stringContaining("訪問診療料"), ukePoints: 888, revPoints: 890, count: 2 },
      { kubun: ["O001_3I"], name: expect.stringContaining("ベースアップ評価料"), ukePoints: 28, revPoints: pointsOf(latest, "O001_3I"), count: 2 },
    ]);
    // 試算の型：判定に使った版（revisionId）と当たったルール（applied）を持たない
    expect(["revisionId" in t, "applied" in t]).toEqual([false, false]);

    // 令和8年度改定後の版（基準月の版）でも試算できる：888／890 と 28／79
    const t8 = (await (await trialOf("U1-1", r2026.id, cookie)).json()) as Trial;
    expect(t8.pointDiffs.map((d) => [d.kubun, d.ukePoints, d.revPoints, d.count])).toEqual([[["C001_1I"], 888, 890, 2], [["O001_3I"], 28, 79, 2]]);
    expect(t8.declared).toEqual({ ho: 6013, ko: [] });
    expect(t8.lines[0]).toEqual({ kubun: "C001_1I", no: expect.any(String), name: expect.stringContaining("訪問診療料"), count: 2, dates: [`${OLD}-14`, `${OLD}-28`], points: 890 });
    // 小計は、その版の点数で数える：6,013 ＋ (890−888)×2 ＋ (79−28)×2。対象外の行はないので、合計も出る
    expect([t8.partial, t8.others, t8.subtotal, t8.total]).toEqual([false, [], 6013 + 2 * 2 + 51 * 2, 6119]);
    // 指摘：コメントのない UKE なので、令和8年度の必須の記載（訪問日・算定開始日・包括的支援加算の状態）が記載もれとして出る。足りない事実は情報不足。
    // 施設は、その診療年月の施設の申告で決まる（design.md §15-2）。デモの種の from_month・算定開始年月日は選べる版のうち最も早い版の開始月なので、
    // 基準月より前の診療年月の試算でも、デモの架空クリニックは同じ施設（v28 と同じ R17 の 3 件だけ。段 17b の R12 の要件不足は作り物の日付から出ていた）
    expect(t8.findings.map((f) => [f.ruleId, f.kind, f.params?.rule]).sort()).toEqual([["R17", "記載もれ", "T176-date"], ["R17", "記載もれ", "T177-first"], ["R17", "記載もれ", "T178-state"]]);
    expect(t8.commentMissingCount).toBe(3);
    expect(t8.missing.length).toBeGreaterThan(0);
    expect(t8.comments).toEqual([]);

    expect(dump(owner)).toEqual(before);
    // 試算の結果は、提出の確定などの入口に渡せない（型検査が落とす。既存の歯止め＝tests/engine/compare.test.ts の (c) が、UKE の試算にも効く）
    const result = instance.runAs(owner, () => instance.getApp().ukeTrial("U1-1", r2026.id));
    // @ts-expect-error UKE の試算の結果は EngineResult ではない（revisionId・applied がない）
    const asEngine: EngineResult = result;
    // @ts-expect-error 確定の記録に試算の結果は入らない
    const confirmed: NonNullable<Question["confirmed"]> = { lines: [], result, at: "" };
    expect([asEngine, confirmed]).toHaveLength(2);
  });

  it("(e) 選べるのはコードの表を持つ版だけ：令和6年度の版・知らない版・版の指定なしは 400。未ログインは 401、医師は 403、一覧にないレセプトは 404", async () => {
    const { cookie, r } = await start("uke_trial_c");
    expect((await r.upload(upload(cookie, sample("kaiteimae.UKE")))).status).toBe(200);
    for (const rev of ["r2024", "r9999", "", null]) {
      const res = await trialOf("U1-1", rev, cookie);
      expect([rev, res.status, ((await res.json()) as { fields?: string[] }).fields]).toEqual([rev, 400, ["rev"]]);
    }
    const c = (await (await check("U1-1", cookie)).json()) as Check;
    expect(c.revisions.map((x) => x.id)).toEqual(UKE_TRIAL_REVISIONS.map((x) => x.id));
    expect(c.revisions.map((x) => x.id)).not.toContain("r2024");
    expect((await trialOf("U1-1", latest.id, null)).status).toBe(401);
    expect((await trialOf("U9-9", latest.id, cookie)).status).toBe(404);
    expect((await trialOf("../x", latest.id, cookie)).status).toBe(400);
    expect((await switchTo(cookie, "manager")).status).toBe(200);
    expect((await trialOf("U1-1", latest.id, cookie)).status).toBe(200);
    expect((await switchTo(cookie, "doctor")).status).toBe(200);
    expect((await trialOf("U1-1", latest.id, cookie)).status).toBe(403);
  });

  it("版のある請求でも試算できる：診療年月の版を選べば点検と同じ指摘・小計で、点数の違いはない。違う版を選べば、その版の点数との違いが並ぶ。点検（版を省いた呼び出し）は変わらない", async () => {
    const { cookie } = await start("uke_trial_d");
    const id = claimId("K2");
    const c = (await (await check(id, cookie)).json()) as Check;
    expect([c.revisionId, c.revisions.map((x) => x.id)]).toEqual([r2026.id, UKE_TRIAL_REVISIONS.map((x) => x.id)]);
    const same = (await (await trialOf(id, r2026.id, cookie)).json()) as Trial;
    expect([same.ownRevisionId, same.trial, same.pointDiffs]).toEqual([r2026.id, { revisionId: r2026.id, claimYearMonth: YM, inPeriod: true }, []]);
    expect([same.findings, same.missing, same.lines, same.subtotal, same.declared, same.comments]).toEqual([c.findings, c.missing, c.lines, c.subtotal, c.declared, c.comments]);
    expect(same.subtotal).toBe(6372);
    // 値の変更の版（適用期間の外）：ベースアップ評価料(Ⅰ) と物価対応料の点数が違う
    const next = (await (await trialOf(id, latest.id, cookie)).json()) as Trial;
    expect(next.trial.inPeriod).toBe(false);
    expect(next.pointDiffs.map((d) => [d.kubun, d.ukePoints, d.revPoints, d.count])).toEqual([
      [["O001_3I"], 79, pointsOf(latest, "O001_3I"), 2],
      [["O100_1HA"], 3, pointsOf(latest, "O100_1HA"), 2],
    ]);
    expect(next.declared).toEqual({ ho: 6372, ko: [] });
    // 点検は、試算のあとも同じ
    expect(await (await check(id, cookie)).json()).toEqual(c);
  });
});
