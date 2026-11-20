// カルテ・患者・症例・UKE のルート（app/api/**/route.ts）を実際に呼んで確かめる：ログイン・スキーマ・請求 id の形・画像の大きさ・監査ログ。
// LLM（Agent SDK）は呼ばない。SDK の query を差し替える（llm.runOnce が返した値の structured が、モデルの返事になる）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { resetLimits } from "../../src/server/rate-limit";
import { claimId, dateIn, day, month, YM } from "../helpers/period";
import { autoConsent } from "../helpers/consent";

const llm = vi.hoisted(() => ({ runOnce: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), llm.runOnce));
// ファイルを読みに行ったか（どのパスか）を見るために、node:fs の読み取りを包む（動きは変えない）
const fsCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const seen = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    fsCalls.paths.push(String(a[0]));
    return fn(...a);
  };
  const wrapped = { ...real, existsSync: seen(real.existsSync), readFileSync: seen(real.readFileSync as (...a: unknown[]) => unknown) };
  return { ...wrapped, default: wrapped };
});

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-chart-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("chart_owner", "かるて", "password123");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
beforeEach(() => {
  resetLimits();
  llm.runOnce.mockReset();
  fsCalls.paths.length = 0;
});

const get = (url: string, c: string | null = cookie) => new Request(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
const post = (url: string, body: unknown, c: string | null = cookie) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
/** 監査ログ（古い順）。since を渡すと、その件数より後に増えた分だけ */
const auditRows = (since = 0) => instance.runAs(user, () => instance.getApp().audit.list(500)).reverse().slice(since);
const fieldsOf = async (r: Response) => ((await r.json()) as { fields?: string[] }).fields;

const NOTE = { s: "動悸なし", o: "脈不整", a: "AF", p: "DOAC 継続", rx: "DOAC" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe("ログイン", () => {
  it("未ログインは、どのルートも 401", async () => {
    const res = await Promise.all([
      (await import("../../app/api/chart/route")).POST(post("/api/chart", { claimId: claimId("K4"), kind: "訪問診療", note: NOTE }, null)),
      (await import("../../app/api/chart/[id]/route")).POST(post("/api/chart/1", { facts: [] }, null), params({ id: "1" })),
      (await import("../../app/api/chart/[id]/claim/route")).GET(get("/api/chart/1/claim", null), params({ id: "1" })),
      (await import("../../app/api/chart/image/route")).POST(post("/api/chart/image", { imageBase64: PNG.toString("base64") }, null)),
      (await import("../../app/api/chart/soap/route")).POST(post("/api/chart/soap", { text: "AF" }, null)),
      (await import("../../app/api/patients/route")).GET(get("/api/patients", null)),
      (await import("../../app/api/patients/[claimId]/facts/route")).GET(get(`/api/patients/${claimId("K1")}/facts`, null), params({ claimId: claimId("K1") })),
      (await import("../../app/api/patients/[claimId]/facts/route")).POST(post(`/api/patients/${claimId("K1")}/facts`, {}, null), params({ claimId: claimId("K1") })),
      (await import("../../app/api/visits/route")).GET(get("/api/visits", null)),
      (await import("../../app/api/cases/route")).GET(get("/api/cases", null)),
      (await import("../../app/api/crosscheck/route")).GET(get(`/api/crosscheck?claimId=${claimId("K4")}`, null)),
      (await import("../../app/api/crosscheck/route")).POST(post("/api/crosscheck", { claimId: claimId("K4"), ruleId: "M01" }, null)),
      (await import("../../app/api/uke/route")).GET(get("/api/uke", null)),
      (await import("../../app/api/uke/route")).POST(post("/api/uke", { name: "kokuhoren.UKE" }, null)),
      (await import("../../app/api/master/route")).GET(get("/api/master", null)),
      (await import("../../app/api/drills/route")).GET(get("/api/drills", null)),
    ]);
    expect(res.map((r) => r.status)).toEqual(res.map(() => 401));
    expect(llm.runOnce).not.toHaveBeenCalled();
  });
});

describe("請求 id の形", () => {
  it("../ や / を含む請求 id は 400 で、ファイルを読みに行かない", async () => {
    const cross = await import("../../app/api/crosscheck/route");
    // 文字種は合っているが存在しない請求 id は、形式違いではなく「見つからない」（アップロードした UKE の請求 id も同じ文字種で受けるため）
    expect((await cross.GET(get(`/api/crosscheck?claimId=K1-${YM.slice(0, 4)}-13`))).status).toBe(404);
    const facts = await import("../../app/api/patients/[claimId]/facts/route");
    // クリニックの DB の用意（初回だけ症例を読む）を先に済ませておく
    instance.runAs(user, () => instance.getApp().cases());
    const chart = (await import("../../app/api/chart/route")).POST;
    for (const bad of ["../../secret", "K1/../../secret", `${claimId("K1")}/x`, "..", `${claimId("K1")}.json`, ` ${claimId("K1")}`]) {
      fsCalls.paths.length = 0;
      const q = await cross.GET(get(`/api/crosscheck?claimId=${encodeURIComponent(bad)}`));
      expect(q.status).toBe(400);
      expect(await fieldsOf(q)).toEqual(["claimId"]);
      expect((await cross.POST(post("/api/crosscheck", { claimId: bad, ruleId: "M01" }))).status).toBe(400);
      expect((await facts.GET(get("/api/patients/x/facts"), params({ claimId: bad }))).status).toBe(400);
      expect((await facts.POST(post("/api/patients/x/facts", { fact: { key: "table7", value: true, source: "カルテ", validUntil: null } }), params({ claimId: bad }))).status).toBe(400);
      expect((await chart(post("/api/chart", { claimId: bad, kind: "訪問診療", note: NOTE }))).status).toBe(400);
      // 症例・カルテ・UKE のファイルには触っていない
      expect(fsCalls.paths.filter((p) => p.includes("fixtures"))).toEqual([]);
    }
    expect(llm.runOnce).not.toHaveBeenCalled();
    // 診療年月が変わっても、同じ形なら通る（症例がなければ 404）
    const later = await facts.GET(get(`/api/patients/K7-${month(12)}/facts`), params({ claimId: `K7-${month(12)}` }));
    expect(later.status).toBe(404);
  });
});

describe("訪問カルテ", () => {
  it("スキーマ違反は 400 と項目名。書いた人を本文で送っても受け取らない", async () => {
    const chart = (await import("../../app/api/chart/route")).POST;
    const body = { claimId: claimId("K4"), kind: "訪問診療", note: NOTE };
    expect(await fieldsOf(await chart(post("/api/chart", { ...body, kind: "外来" })))).toEqual(["kind"]);
    expect(await fieldsOf(await chart(post("/api/chart", { ...body, note: { ...NOTE, s: "あ".repeat(4001) } })))).toEqual(["note.s"]);
    expect(await fieldsOf(await chart(post("/api/chart", { ...body, note: { s: "", o: "", a: "", p: "" } })))).toEqual(["note.rx"]);
    const named = await chart(post("/api/chart", { ...body, clerkId: "someone" }));
    expect(named.status).toBe(400);
    expect(await fieldsOf(named)).toEqual(["clerkId"]);
    const confirm = (await import("../../app/api/chart/[id]/route")).POST;
    expect(await fieldsOf(await confirm(post("/api/chart/x", { facts: [] }), params({ id: "1; DROP" })))).toEqual(["id"]);
    expect(await fieldsOf(await confirm(post("/api/chart/1", { facts: [{ kind: "判定", value: "x", quote: "x" }] }), params({ id: "1" })))).toEqual(["facts.0.kind"]);
    expect(llm.runOnce).not.toHaveBeenCalled();
  });

  it("書く → 事実を取り出す → 確かめる、が今までどおり動き、監査ログにカルテの本文は入らない", async () => {
    const chart = (await import("../../app/api/chart/route")).POST;
    const confirm = (await import("../../app/api/chart/[id]/route")).POST;
    const before = auditRows().length;
    llm.runOnce.mockResolvedValue({ structured: { facts: [{ kind: "処方", value: "DOAC", quote: "DOAC 継続" }, { kind: "病名の記載", value: "心不全", quote: "カルテにない言葉" }] }, sessionId: "", stats: {} });
    const written = await chart(post("/api/chart", { claimId: claimId("K4"), kind: "訪問診療", note: NOTE }));
    expect(written.status).toBe(200);
    const w = (await written.json()) as { id: number; date: string; facts: unknown[]; dropped: unknown[] };
    expect(w).toMatchObject({ date: day(13), facts: [{ kind: "処方", value: "DOAC", quote: "DOAC 継続" }] });
    expect(w.dropped).toHaveLength(1);
    expect(llm.runOnce).toHaveBeenCalledOnce();

    // カルテにない言葉の事実は 400（文言つき）、ないカルテは 404、確かめたあとの 2 回目は 409
    const made = await confirm(post(`/api/chart/${w.id}`, { facts: [{ kind: "処方", value: "DOAC", quote: "エリキュース" }] }), params({ id: String(w.id) }));
    expect(made.status).toBe(400);
    expect((await made.json()).error).toContain("カルテにない言葉の事実がある");
    expect((await confirm(post("/api/chart/9999", { facts: [] }), params({ id: "9999" }))).status).toBe(404);
    const ok = await confirm(post(`/api/chart/${w.id}`, { facts: w.facts }), params({ id: String(w.id) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ claimId: claimId("K4"), date: day(13) });
    expect((await confirm(post(`/api/chart/${w.id}`, { facts: w.facts }), params({ id: String(w.id) }))).status).toBe(409);

    // 書いた訪問が、本人の訪問の記録に出る
    const visits = (await (await (await import("../../app/api/visits/route")).GET(get("/api/visits"))).json()) as { claimId: string; date: string; written: boolean }[];
    expect(visits.find((v) => v.claimId === claimId("K4") && v.date === day(13))).toMatchObject({ written: true });

    // 監査ログ：対象は請求 id・カルテの id だけ
    expect(auditRows(before).map((r) => [r.action, r.target, r.result])).toEqual([
      ["POST /api/chart", claimId("K4"), "ok"],
      ["POST /api/chart/[id]", String(w.id), "rejected"],
      ["POST /api/chart/[id]", "9999", "rejected"],
      ["POST /api/chart/[id]", String(w.id), "ok"],
      ["POST /api/chart/[id]", String(w.id), "rejected"],
    ]);
    // これまでの全部の行（検証で落ちたものも含む）に、カルテの本文は入っていない
    const all = JSON.stringify(auditRows());
    for (const text of [...Object.values(NOTE), "エリキュース", "あああ"]) expect(all).not.toContain(text);
  });

  it("5 欄を上限の字数まで日本語で書いても、本文の大きさでは断らない（413 にならない）", async () => {
    const chart = (await import("../../app/api/chart/route")).POST;
    const full = "あ".repeat(4000);
    // 症例のない請求 id にして、LLM を呼ぶ前（請求を確かめるところ）で止める
    const r = await chart(post("/api/chart", { claimId: claimId("K9"), kind: "訪問診療", note: { s: full, o: full, a: full, p: full, rx: full } }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe(`症例がない: ${claimId("K9")}`);
    expect(llm.runOnce).not.toHaveBeenCalled();
  });

  it("同じクリニックのほかの人が書いたカルテも確定でき、誰が確かめたかが監査ログに残る", async () => {
    const chart = (await import("../../app/api/chart/route")).POST;
    const confirm = (await import("../../app/api/chart/[id]/route")).POST;
    llm.runOnce.mockResolvedValue({ structured: { facts: [{ kind: "処方", value: "DOAC", quote: "DOAC 継続" }] }, sessionId: "", stats: {} });
    const w = (await (await chart(post("/api/chart", { claimId: claimId("K5"), kind: "訪問診療", note: NOTE }))).json()) as { id: number; facts: unknown[] };
    // 招待で同じクリニックに入ったベテランが確かめる
    const { code } = instance.getAuth().createInvite(user, "veteran");
    const mate = instance.getAuth().registerWithInvite("chart_mate", "どうりょう", "password123", code);
    const mateCookie = `resemen_session=${instance.getAuth().createSession(mate.id).token}`;
    const ok = await confirm(post(`/api/chart/${w.id}`, { facts: w.facts }, mateCookie), params({ id: String(w.id) }));
    expect(ok.status).toBe(200);
    expect(auditRows().at(-1)).toMatchObject({ action: "POST /api/chart/[id]", target: String(w.id), result: "ok", userId: mate.id, role: "veteran" });
  });

  it("確定したカルテの算定プレビュー：その日までの出来事から導出した行・根拠・見込みの合計・指摘を返す。確かめる前は 409、形の違う choices は 400", async () => {
    const chart = (await import("../../app/api/chart/route")).POST;
    const confirm = (await import("../../app/api/chart/[id]/route")).POST;
    const claim = (await import("../../app/api/chart/[id]/claim/route")).GET;
    llm.runOnce.mockResolvedValue({ structured: { facts: [] }, sessionId: "", stats: {} });
    const w = (await (await chart(post("/api/chart", { claimId: claimId("K1"), kind: "訪問診療", note: NOTE }))).json()) as { id: number };
    const at = params({ id: String(w.id) });
    expect((await claim(get(`/api/chart/${w.id}/claim`), at)).status).toBe(409);
    expect((await confirm(post(`/api/chart/${w.id}`, { facts: [] }), at)).status).toBe(200);
    const before = auditRows().length;

    const res = await claim(get(`/api/chart/${w.id}/claim`), at);
    expect(res.status).toBe(200);
    const c = (await res.json()) as { claimId: string; date: string; totalStatus: string; total: number | null; lines: { kubun: string; count: number; dates: string[]; subtotal: number; basis: { tentative: boolean; events: string[] } | null }[]; pending: unknown[]; findings: unknown[]; patientFindings: unknown[] };
    // 時計の初期値（基準月の 13 日）の訪問 1 回：訪問診療料と届出の加算、管理料は月 1 回の区分（見込み）と包括的支援加算
    expect(c).toMatchObject({ claimId: claimId("K1"), date: day(13), totalStatus: "tentative", pending: [], findings: [] });
    expect(c.lines.map((l) => [l.kubun, l.count, l.dates])).toEqual([
      ["C001_1I", 1, [day(13)]],
      ["C002_2NI1", 1, [day(13)]],
      ["C002_N10_HOKATSU", 1, [day(13)]],
      ["C001_N13_DX", 1, [day(13)]],
      ["O001_3I", 1, [day(13)]],
      ["O100_1HA", 1, [day(13)]],
    ]);
    expect(c.lines.filter((l) => l.basis?.tentative).map((l) => l.kubun)).toEqual(["C002_2NI1", "C002_N10_HOKATSU"]);
    for (const l of c.lines) expect(l.basis?.events.length).toBeGreaterThan(0);
    expect(c.total).toBe(c.lines.reduce((s, l) => s + l.subtotal, 0));
    expect(Array.isArray(c.patientFindings)).toBe(true);

    expect((await claim(get(`/api/chart/${w.id}/claim?choices=${encodeURIComponent("[1]")}`), at)).status).toBe(400);
    expect((await claim(get(`/api/chart/${w.id}/claim?choices=${encodeURIComponent("{")}`), at)).status).toBe(400);
    // 今の保留にない答えは無視する（落とさない）
    expect((await claim(get(`/api/chart/${w.id}/claim?choices=${encodeURIComponent(JSON.stringify({ "D11-mitori:x": "mitori" }))}`), at)).status).toBe(200);
    // 読むだけなので、監査ログには残らない
    expect(auditRows(before)).toEqual([]);
  });

  it("SOAP に整える：空・4000 字超は 400。整えた欄を返す", async () => {
    const soap = (await import("../../app/api/chart/soap/route")).POST;
    const empty = await soap(post("/api/chart/soap", { text: "  " }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("カルテが空です");
    expect(await fieldsOf(await soap(post("/api/chart/soap", { text: "あ".repeat(4001) })))).toEqual(["text"]);
    expect(llm.runOnce).not.toHaveBeenCalled();
    llm.runOnce.mockResolvedValue({ structured: { s: "動悸なし", o: "", a: "AF", p: "", rx: "" }, sessionId: "", stats: {} });
    const ok = await soap(post("/api/chart/soap", { text: "動悸なし。AF" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ note: { s: "動悸なし", o: "", a: "AF", p: "", rx: "" }, unmatched: [] });
    expect(auditRows().filter((r) => r.action === "POST /api/chart/soap").every((r) => r.target === null)).toBe(true);
  });
});

describe("カルテの画像", () => {
  it("大きすぎる本文は読まずに 413。画像でないものは 400。どちらも LLM を呼ばない", async () => {
    const image = (await import("../../app/api/chart/image/route")).POST;
    // 5MB を超える画像（base64 で約 6.9MB）
    const big = await image(post("/api/chart/image", { imageBase64: Buffer.alloc(5 * 1024 * 1024 + 3000, 1).toString("base64") }));
    expect(big.status).toBe(413);
    // content-length だけが大きいものも、読む前に断る
    const declared = new Request("http://localhost/api/chart/image", { method: "POST", headers: { cookie, "content-type": "application/json", "content-length": String(50_000_000) }, body: "{}" });
    expect((await image(declared)).status).toBe(413);
    // 5MB ちょうどまでは本文の上限に掛からない（PNG の先頭を持つので、検査を通って読み取りに進む）
    llm.runOnce.mockResolvedValue({ structured: { diseases: "心房細動", record: "AF。DOAC 継続", rx: "DOAC", unreadable: false }, sessionId: "", stats: {} });
    const full = Buffer.alloc(5 * 1024 * 1024);
    PNG.copy(full);
    expect((await image(post("/api/chart/image", { imageBase64: full.toString("base64") }))).status).toBe(200);
    llm.runOnce.mockReset();

    const notImage = await image(post("/api/chart/image", { imageBase64: Buffer.from("これは画像ではない").toString("base64") }));
    expect(notImage.status).toBe(400);
    expect((await notImage.json()).error).toBe("PNG・JPEG・WebP の画像を選んでください");
    const empty = await image(post("/api/chart/image", { imageBase64: "" }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("画像が空か、5MB を超えています");
    expect(await fieldsOf(await image(post("/api/chart/image", { imageBase64: "data:image/png;base64,AAAA" })))).toEqual(["imageBase64"]);
    expect(llm.runOnce).not.toHaveBeenCalled();
  });

  it("文字を読み取れない画像は 400 と文言（定型文の 500 にしない）", async () => {
    const image = (await import("../../app/api/chart/image/route")).POST;
    llm.runOnce.mockResolvedValue({ structured: { diseases: "", record: "", rx: "", unreadable: true }, sessionId: "", stats: {} });
    const r = await image(post("/api/chart/image", { imageBase64: PNG.toString("base64") }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("画像からカルテの文字を読み取れませんでした");
  });

  it("画像を渡すと、書き写した文を返す", async () => {
    const image = (await import("../../app/api/chart/image/route")).POST;
    llm.runOnce.mockResolvedValue({ structured: { diseases: "心房細動", record: "AF。DOAC 継続", rx: "DOAC", unreadable: false }, sessionId: "", stats: {} });
    const ok = await image(post("/api/chart/image", { imageBase64: PNG.toString("base64") }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toBe("AF。DOAC 継続\n病名：心房細動\n処方：DOAC");
  });
});

describe("患者ごとに確かめた情報", () => {
  it("保存と一覧が今までどおり動く。確かめた人はセッションの本人で、項目の決まりに合わない入力は 400 と文言", async () => {
    const facts = await import("../../app/api/patients/[claimId]/facts/route");
    const p = params({ claimId: claimId("K1") });
    const before = auditRows().length;
    const save = (fact: unknown, extra: Record<string, unknown> = {}) => facts.POST(post(`/api/patients/${claimId("K1")}/facts`, { fact, ...extra }), p);

    const named = await save({ key: "table7", value: true, source: "カルテ", validUntil: null }, { clerkId: "someone" });
    expect(await fieldsOf(named)).toEqual(["clerkId"]);
    expect(await fieldsOf(await save({ key: "name", value: true, source: "カルテ", validUntil: null }))).toEqual(["fact.key"]);
    expect(await fieldsOf(await save({ key: "table7", value: true, source: "うわさ", validUntil: null }))).toEqual(["fact.source"]);
    const noDate = await save({ key: "careLevel", value: 3, source: "介護保険証", validUntil: null });
    expect(noDate.status).toBe(400);
    expect((await noDate.json()).error).toBe("要介護度には有効期間の終わりの日が要る");
    const past = await save({ key: "careLevel", value: 3, source: "介護保険証", validUntil: dateIn(-1, 28) });
    expect(past.status).toBe(400);
    expect((await past.json()).error).toBe("有効期間の終わりが今日より前になっている");

    const ok = await save({ key: "careLevel", value: 3, source: "介護保険証", validUntil: dateIn(6, 30) });
    expect(ok.status).toBe(200);
    const listed = (await (await facts.GET(get(`/api/patients/${claimId("K1")}/facts`), p)).json()) as { facts: { key: string; value: unknown; checkedBy: string; expired: boolean }[] };
    expect(listed.facts).toHaveLength(1);
    expect(listed.facts[0]).toMatchObject({ key: "careLevel", value: 3, expired: false, checkedBy: instance.clerkIdOf(user) });
    expect(auditRows(before).map((r) => [r.action, r.target, r.result])).toEqual([
      ...["invalid", "invalid", "invalid", "rejected", "rejected", "ok"].map((result) => ["POST /api/patients/[claimId]/facts", claimId("K1"), result]),
    ]);
  });
});

describe("一覧・照合・UKE", () => {
  it("一覧が今までどおり返る。区分の一覧はどのロールでも、算定の一覧は事務・ベテランだけ", async () => {
    const patients = (await (await (await import("../../app/api/patients/route")).GET(get("/api/patients"))).json()) as { claimId: string }[];
    expect(patients.length).toBeGreaterThan(0);
    expect(patients.every((x) => new RegExp(`^K\\d-${YM}$`).test(x.claimId))).toBe(true);
    const cases = (await (await (await import("../../app/api/cases/route")).GET(get("/api/cases"))).json()) as { claimId: string }[];
    expect(cases.map((c) => c.claimId).sort()).toEqual([claimId("K1"), claimId("K2"), claimId("K3"), claimId("K4"), claimId("K5"), claimId("K6"), claimId("K7")]);
    expect((await (await import("../../app/api/drills/route")).GET(get("/api/drills"))).status).toBe(200);
    const master = (await (await (await import("../../app/api/master/route")).GET(get("/api/master"))).json()) as { kubun: string }[];
    expect(master.length).toBeGreaterThan(0);

    // 医師ロール（1 人クリニックの持ち主が切り替えた）：区分の一覧は見られるが、症例・UKE は 403
    const doc = instance.getAuth().register("chart_doc", "せんせい", "password123");
    const docCookie = `resemen_session=${instance.getAuth().createSession(doc.id).token}`;
    expect((await (await import("../../app/api/auth/role/route")).POST(post("/api/auth/role", { role: "doctor" }, docCookie))).status).toBe(200);
    expect((await (await import("../../app/api/master/route")).GET(get("/api/master", docCookie))).status).toBe(200);
    expect((await (await import("../../app/api/cases/route")).GET(get("/api/cases", docCookie))).status).toBe(403);
    expect((await (await import("../../app/api/uke/route")).POST(post("/api/uke", { name: "kokuhoren.UKE" }, docCookie))).status).toBe(403);
    expect((await (await import("../../app/api/patients/[claimId]/facts/route")).POST(post(`/api/patients/${claimId("K1")}/facts`, { fact: { key: "table7", value: true, source: "カルテ", validUntil: null } }, docCookie), params({ claimId: claimId("K1") }))).status).toBe(403);
  });

  it("照合：本人の id は受け取らない（クエリでも本文でも 400）。日付の形でない asOf は 400", async () => {
    const cross = await import("../../app/api/crosscheck/route");
    const ok = await cross.GET(get(`/api/crosscheck?claimId=${claimId("K4")}&asOf=${day(12)}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty("mismatches");
    expect(await fieldsOf(await cross.GET(get(`/api/crosscheck?claimId=${claimId("K4")}&clerkId=someone`)))).toEqual(["clerkId"]);
    expect(await fieldsOf(await cross.POST(post("/api/crosscheck", { claimId: claimId("K4"), ruleId: "M01", clerkId: "someone" })))).toEqual(["clerkId"]);
    expect(await fieldsOf(await (await import("../../app/api/me/route")).GET(get("/api/me?clerkId=someone")))).toEqual(["clerkId"]);
    expect(await fieldsOf(await cross.GET(get(`/api/crosscheck?claimId=${claimId("K4")}&asOf=3/10`)))).toEqual(["asOf"]);
    expect(await fieldsOf(await cross.GET(get("/api/crosscheck")))).toEqual(["claimId"]);
    expect(await fieldsOf(await cross.POST(post("/api/crosscheck", { claimId: claimId("K4"), ruleId: "../M01" })))).toEqual(["ruleId"]);
  });

  it("照合から医師確認を送る：不一致がなければ 404、送ってあれば 409（どちらも文言つき）", async () => {
    const cross = await import("../../app/api/crosscheck/route");
    const none = await cross.POST(post("/api/crosscheck", { claimId: claimId("K4"), ruleId: "M99" }));
    expect(none.status).toBe(404);
    expect((await none.json()).error).toBe(`不一致がない: ${claimId("K4")} M99`);
    const { mismatches } = (await (await cross.GET(get(`/api/crosscheck?claimId=${claimId("K4")}`))).json()) as { mismatches: { ruleId: string }[] };
    expect(mismatches.length).toBeGreaterThan(0);
    const body = { claimId: claimId("K4"), ruleId: mismatches[0].ruleId };
    const sent = await cross.POST(post("/api/crosscheck", body));
    expect(sent.status).toBe(200);
    const again = await cross.POST(post("/api/crosscheck", body));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/^医師確認はもう送ってある: q-[0-9a-f]{12}$/);
  });

  it("UKE の取り込み：用意した名前だけ。パスを含む名前は 400", async () => {
    const uke = await import("../../app/api/uke/route");
    const before = (await (await uke.GET(get("/api/uke"))).json()) as { name: string; imported: boolean }[];
    expect(before.map((u) => [u.name, u.imported])).toEqual([["kokuhoren.UKE", false], ["shiharaikikin.UKE", false]]);
    expect(await fieldsOf(await uke.POST(post("/api/uke", { name: "../../fixtures/uke/kokuhoren.UKE" })))).toEqual(["name"]);
    expect(await fieldsOf(await uke.POST(post("/api/uke", { name: "kokuhoren.UKE", clerkId: "someone" })))).toEqual(["clerkId"]);
    const unknown = await uke.POST(post("/api/uke", { name: "other.UKE" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("取り込める UKE ではない");
    const ok = await uke.POST(post("/api/uke", { name: "kokuhoren.UKE" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { name: string; imported: boolean }[]).map((u) => u.imported)).toEqual([true, false]);
    expect(auditRows().filter((r) => r.action === "POST /api/uke" && r.result === "ok").map((r) => r.target)).toEqual(["kokuhoren.UKE"]);
  });
});
