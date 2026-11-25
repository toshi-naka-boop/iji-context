// 保存時の暗号化の受け入れ（spec FR-212〜216）：鍵を付けて、目印の患者名を入れた UKE の取り込み・カルテ・医師確認・メンターの会話まで一通り動かしたあと、
// データの置き場のどのファイルにも目印が出てこない。SQLite の印で始まるファイルがない。包んだファイルを 1 バイト変えると読み込みが誤りで止まる。
// AI は呼ばない（SDK を差し替える）。メンターの会話の記録は、SDK に渡した sessionStore に、SDK が写すのと同じ形で書いて確かめる。鍵はその場で作る
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import type { SessionStore } from "../../src/llm/outbound";
import { autoConsent } from "../helpers/consent";
import { claimId, YM } from "../helpers/period";
import type { SdkCall } from "../helpers/sdk";

const repo = path.join(__dirname, "..", "..");
/** 目印の患者名（ほかの文に偶然は現れない並び）と、カルテ・医師確認・会話に入れる印 */
const MARK = "目印暗号子";
const MARK_NO = "MKENC9921";

const sdk = vi.hoisted(() => ({ calls: [] as SdkCall[] }));
/** 差し替えたモデルの返事：求められた形に合う最小の返事 */
async function respond(call: SdkCall): Promise<{ structured: unknown }> {
  const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
  if (props.includes("expression")) return { structured: { body: "見るとよい場所があります。", expression: "通常", citedKnowledge: [], topic: "算定" } };
  if (props.includes("answerable")) return { structured: { answerable: false, body: "", citedKnowledge: [] } };
  if (props.includes("facts")) return { structured: { facts: [], acts: [], rx: [] } };
  return { structured: { s: "", o: "", a: "", p: "", rx: "" } };
}
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), respond, sdk.calls));

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let uploaded: string;

/** 置き場の全部のファイル（WAL・一時ファイルを含む） */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
}
/** 目印の、ファイルに現れうる形（UTF-8・UKE の Shift_JIS・UTF-16） */
const needles = [MARK, MARK_NO].flatMap((m) => [Buffer.from(m, "utf8"), iconv.encode(m, "Shift_JIS"), Buffer.from(m, "utf16le")]);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-encrypt-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "workspaces");
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "sdk-local");
  process.env.RESEMEN_DATA_KEY = randomBytes(32).toString("hex");
  vi.spyOn(console, "info").mockImplementation(() => {});
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("enc_owner", "やまだ", "password123");
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "kokuhoren.UKE")));
  const patient: UkePatient = {
    name: MARK,
    sex: 2,
    birth: "19300101",
    receiptType: "1318",
    insurer: { number: "39771355", symbol: "MKSYM", no: MARK_NO },
    kohi: [],
    diseases: [{ name: "心房細動", start: "20250401", main: true }],
  };
  const file: UkeFile = { ...base, receipts: [{ claimId: "MKCH1", yearMonth: YM, patient, lines: base.receipts.find((r) => r.claimId === claimId("K2"))!.lines, comments: [], commentsKnown: true }] };
  uploaded = instance.runAs(user, () => instance.getApp().uploadUke(instance.clerkIdOf(user), writeUke(file)).find((u) => u.uploaded)!.receipts[0].claimId);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ["RESEMEN_DATA", "RESEMEN_WORKSPACES", "CLAUDE_CONFIG_DIR", "RESEMEN_DATA_KEY"]) delete process.env[k];
});

describe("保存時の暗号化（受け入れ）", () => {
  it("UKE の取り込み・カルテ・医師確認・メンターの会話のあと、置き場のどのファイルにも目印が出ず、SQLite の印で始まるファイルもない", async () => {
    const me = instance.clerkIdOf(user);
    let store: SessionStore | undefined;
    await instance.runAs(user, async () => {
      const a = instance.getApp();
      // 取り込んだレセプトが読めて、患者名が戻る（鍵で開ける）
      expect(a.ukeList(me).find((u) => u.uploaded)!.receipts[0].patient).toBe(MARK);
      // カルテ（取り込んだ請求に貼る。自由記述に目印。DB の chart_notes に入る）
      await instance.pasteRecord({ user, claimId: uploaded, clerkId: me, date: `${YM}-05`, note: { s: `本人は ${MARK} と名乗る`, o: MARK_NO, a: "AF", p: "", rx: "" } });
      // 医師確認（query-log/ のファイル）
      const { createQuery } = await import("../../src/query/doctor-query");
      createQuery(a.queryLog, { claimId: uploaded, field: "病型", why: "記載がない", question: "病型について、該当するものを選んでください。", indicators: [{ source: "カルテ", text: `${MARK} の記載` }], options: ["発作性", "持続性", "その他", "判定不能"], createdBy: "clerk" }, a.now());
      expect(a.queryLog && (await import("../../src/query/doctor-query")).listQueries(a.queryLog).some((q) => q.indicators[0].text.includes(MARK))).toBe(true);
      // メンターの会話：SDK には、このクリニックの会話の記録の置き場（sessionStore）が渡る
      const q = a.start(me, uploaded);
      await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: `${MARK} さんの算定は？`, situation: "通常" });
      const mentorCall = sdk.calls.find((c) => (c.options.outputFormat as { schema?: { properties?: object } }).schema?.properties && "expression" in ((c.options.outputFormat as { schema: { properties: object } }).schema.properties as object));
      store = mentorCall?.options.sessionStore as SessionStore | undefined;
      expect(store).toBe(a.sessionStore);
    });
    // SDK が写すのと同じ形で、会話の記録を置き場に書く（本物の SDK は呼ばない）。読み戻すと同じ中身
    const key = { projectKey: "-data-workspaces-x", sessionId: "11111111-2222-4333-8444-555555555555" };
    const entries = [
      { type: "user", uuid: "u1", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: `${MARK} さんの算定は？` } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: `${MARK_NO} を確かめます` }] } },
    ];
    await store!.append(key, entries);
    await store!.append(key, entries); // 同じ uuid は二度入れない
    expect(await store!.load(key)).toEqual(entries);
    expect(await store!.listSessions!(key.projectKey)).toEqual([{ sessionId: key.sessionId, mtime: expect.any(Number) }]);

    const files = allFiles(tmp);
    expect(files.some((f) => f.endsWith("app.db"))).toBe(true);
    expect(files.some((f) => f.endsWith("auth.db"))).toBe(true);
    expect(files.some((f) => /[0-9a-f]{64}\.UKE$/.test(f))).toBe(true);
    expect(files.some((f) => /query-log\/.+\.json$/.test(f))).toBe(true);
    const leaks = files.filter((f) => {
      const b = readFileSync(f);
      return needles.some((n) => b.includes(n));
    });
    expect(leaks.map((f) => path.relative(tmp, f))).toEqual([]);
    const sqliteHeaders = files.filter((f) => readFileSync(f).subarray(0, 15).toString("latin1") === "SQLite format 3");
    expect(sqliteHeaders.map((f) => path.relative(tmp, f))).toEqual([]);

    // 会話の記録は、消す処理（取り込んだファイル・クリニックを消すとき）で置き場からも消える
    const { forgetSessions } = await import("../../src/llm/outbound");
    await forgetSessions(path.join(tmp, "workspaces", user.tenantId, me), [key.sessionId], store);
    expect(await store!.load(key)).toBeNull();
  });

  it("包んだ UKE を 1 バイト変えると、読み込みが誤りで止まる（黙って空の一覧にしない）。戻せば読める", () => {
    const stored = allFiles(tmp).find((f) => /[0-9a-f]{64}\.UKE$/.test(f))!;
    const raw = readFileSync(stored);
    const bad = Buffer.from(raw);
    bad[raw.length - 3] ^= 0xff;
    writeFileSync(stored, bad);
    try {
      instance.reopenTenant(user.tenantId);
      expect(() => instance.runAs(user, () => instance.getApp().ukeList(instance.clerkIdOf(user)))).toThrow(/改ざんされたか、鍵が違います/);
    } finally {
      writeFileSync(stored, raw);
    }
    instance.reopenTenant(user.tenantId);
    expect(instance.runAs(user, () => instance.getApp().ukeList(instance.clerkIdOf(user)).find((u) => u.uploaded)!.receipts[0].patient)).toBe(MARK);
  });

  it("違う鍵では起動の確かめで止まり、置き場のデータベースは変わらない", async () => {
    const { assertAtRest } = await import("../../src/server/at-rest");
    const auth = path.join(tmp, "auth.db");
    const before = readFileSync(auth);
    expect(assertAtRest(process.env, { data: tmp, root: tmp })).toEqual({ encrypted: true });
    expect(() => assertAtRest({ ...process.env, RESEMEN_DATA_KEY: randomBytes(32).toString("hex") }, { data: tmp, root: tmp })).toThrow(/合いません/);
    expect(readFileSync(auth).equals(before)).toBe(true);
  });
});
