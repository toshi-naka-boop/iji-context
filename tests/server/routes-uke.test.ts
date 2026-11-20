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
  receipts: { claimId: string; patient: string; patientNo: string | null; sameMonth: boolean; otherRows: number; unreadable: string | null }[];
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
    /** 見本（K6）の行：1 IR・2 RE・3 HO・4 SY・5 SI・6 SI・7 GO */
    const broken: [string, Buffer, string][] = [
      ["列数の不足", enc(text.replace(/^(SI,.*),\r\n/m, "$1\r\n")), "5 行目：列数が合わない"],
      ["範囲外の数値", withCell(5, 6, "0"), "5 行目：回数が範囲の外"],
      ["版の点数表と合わない点数", withCell(5, 5, "131"), "5 行目：点数が診療年月の版の点数表と合わない"],
      ["上限を超える日別回数", withCell(5, 13, "999999999"), "5 行目：1 日の回数が上限を超えている"],
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
    expect(j1.findings.map(missing)).toEqual(expect.arrayContaining([["R02", "情報不足", "doctor", "table8_2"], ["R16", "情報不足", "clerk", "residence"], ["R14", "情報不足", "clerk", "chartRecord"]]));
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
