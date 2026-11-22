// 外部へ送る処理（design.md §11-11）。完了条件 (b)：AI の SDK・音声の API を読み込むのは決めたファイルだけ。
// 完了条件 (c)：識別子に目印の値を入れた請求と、同梱の症例で、AI に送る文（プロンプト・指示・ツールの返事）と、メンターの作業場所・ログ・監査ログに目印が現れない。
// AI は呼ばない（SDK を差し替え、送られたものを全部ためる）
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConsentRequired } from "../../src/server/errors";
import type { User } from "../../src/server/auth";
import type { ClaimContext } from "../../src/engine/types";
import type { UkeFile, UkePatient } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import { claimId, YM } from "../helpers/period";
import type { SdkCall } from "../helpers/sdk";

const repo = path.join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// (b) 読み込みの場所

function sources(dir: string): string[] {
  return readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === "runs" ? [] : sources(path.join(dir, e.name))) : /\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}
const files = [...["app", "src", "scripts", "eval", path.join("fixtures", "connect")].flatMap(sources), "proxy.ts"].map((f) => f.split(path.sep).join("/"));
const using = (pattern: RegExp) => files.filter((f) => pattern.test(readFileSync(path.join(repo, f), "utf8"))).sort();

describe("外部へ送る処理の場所（ソースを走査する）", () => {
  it("走査の対象に、ルート・サーバー・スクリプト・評価のソースが入っている", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const f of ["app/api/mentor/route.ts", "src/server/instance.ts", "src/llm/outbound.ts", "eval/run-eval.ts", "scripts/seed-knowledge.ts"]) expect(files).toContain(f);
  });
  it("AI の SDK を読み込むのは src/llm/outbound.ts だけ（文字列としても、ほかのファイルに現れない）", () => {
    expect(using(/claude-agent-sdk|@anthropic-ai\/|anthropic\.com/)).toEqual(["src/llm/outbound.ts"]);
  });
  it("音声の API を読み込むのは src/voice/ だけ", () => {
    const hits = using(/@elevenlabs\/|elevenlabs\.io/);
    expect(hits).toEqual(["src/voice/elevenlabs.ts"]);
    // ほかのファイルは、音声の SDK のクライアントも直接は作らない
    expect(using(/\bElevenLabsClient\b/)).toEqual(["src/voice/elevenlabs.ts"]);
  });
});

// ---------------------------------------------------------------------------
// (c) 識別子

const sdk = vi.hoisted(() => ({ calls: [] as SdkCall[], toolResults: [] as string[] }));
/** 差し替えたモデルの返事：求められた形（outputFormat）に合う最小の返事。メンターの回では、自前のツールを全部呼び、返事をためる（ツールの返事も AI に届く文） */
async function respond(call: SdkCall): Promise<{ structured: unknown }> {
  const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
  const server = (call.options.mcpServers as Record<string, { instance: unknown }> | undefined)?.resemen;
  if (server) {
    const tools = (server.instance as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
    const doctor = { field: "病型", why: "記載がない", question: "病型について、該当するものを選んでください。", indicators: [{ source: "カルテ", text: "AF" }], options: ["発作性", "持続性", "その他", "判定不能"] };
    const args: Record<string, unknown> = { query_history: {}, ask_peer_mentor: { question: "この加算の条件は？" }, ask_human: { question: "院内ではどうしていますか" }, ask_doctor: doctor, ask_missing: { target: "clerk", field: "要介護度", why: "記載がない" } };
    for (const [name, a] of Object.entries(args)) sdk.toolResults.push(JSON.stringify(await tools[name].handler(a, {})));
    sdk.toolResults.push(JSON.stringify(await tools.ask_missing.handler({ target: "doctor", ...doctor, field: "病型2" }, {})));
  }
  if (props.includes("expression")) return { structured: { body: "見るとよい場所があります。", expression: "通常", citedKnowledge: [], topic: "算定" } };
  if (props.includes("answerable")) return { structured: { answerable: false, body: "", citedKnowledge: [] } };
  // カルテの読み取り：事実と行ったこと・処方の記載（同じ 1 回の呼び出し。design.md §15-6）
  if (props.includes("facts")) return { structured: { facts: [], acts: [{ category: "投薬", written: "DOAC", lookup: ["DOAC"], quote: "DOAC 継続" }], rx: [{ quote: "DOAC" }] } };
  if (props.includes("missing")) return { structured: { text: "本日訪問。変わりなし。", missing: [] } };
  if (props.includes("reading")) return { structured: { reading: "やまだ" } };
  if (props.includes("documentType")) return { structured: { documentType: "", prefecture: "", items: [] } };
  if (props.includes("unreadable")) return { structured: { diseases: "心房細動", record: "AF", rx: "DOAC", unreadable: false } };
  return { structured: { s: "動悸なし", o: "", a: "AF", p: "", rx: "" } };
}
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), respond, sdk.calls));

/** 目印の値（どれも、ほかの文に偶然は現れない並び） */
const MARK = {
  name: "目印花子乙",
  birth: "19030917",
  insurerNumber: "39771355",
  symbol: "MKSYM7731",
  no: "MKNO55193",
  kohiPayer: "12771359",
  kohiRecipient: "7713597",
  clinicCode: "7713551",
  clinicName: "目印診療所丙",
  clinicPhone: "0377135519",
  extra: "目印の追加項目丁",
  chartNo: "MKCHART7735",
};
/** 利用者が自分で打ち込む文（外せないもの。そのまま送られる）に入れる印：送られたものを取りこぼしていないことの確かめに使う */
const FREE_TEXT = "自由記述の印戊";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let outbound: typeof import("../../src/llm/outbound");
let user: User;
let uploaded: string;
const logs: string[] = [];

/** フォルダの中のファイルの中身（リンクの先も読む） */
function contents(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? contents(f) : [`${f}\n${readFileSync(f, "utf8")}`];
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-outbound-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  instance = await import("../../src/server/instance");
  outbound = await import("../../src/llm/outbound");
  autoConsent(instance.getAuth());
  user = instance.getAuth().switchRole(instance.getAuth().register("outbound_owner", "やまだ", "password123"), "veteran");
  // 識別子に目印を入れたレセプトを 1 件、取り込む（行は見本から借りる）
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "kokuhoren.UKE")));
  const patient: UkePatient = {
    name: MARK.name,
    sex: 2,
    birth: MARK.birth,
    receiptType: "1318",
    insurer: { number: MARK.insurerNumber, symbol: MARK.symbol, no: MARK.no },
    kohi: [{ payerNo: MARK.kohiPayer, recipientNo: MARK.kohiRecipient }],
    diseases: [{ name: "心房細動", start: "20250401", main: true }],
  };
  const file: UkeFile = {
    ...base,
    clinic: { code: MARK.clinicCode, name: MARK.clinicName, phone: MARK.clinicPhone },
    // カルテ番号（患者の番号）も識別子。請求 id にはアプリの番号が振られるので、AI には届かない
    receipts: [{ claimId: MARK.chartNo, yearMonth: YM, patient, lines: base.receipts.find((r) => r.claimId === claimId("K2"))!.lines, comments: [], commentsKnown: true }],
  };
  uploaded = instance.runAs(user, () => {
    const a = instance.getApp();
    const list = a.uploadUke(instance.clerkIdOf(user), writeUke(file));
    return list.find((u) => u.uploaded)!.receipts[0].claimId;
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

describe("AI に送る文脈から識別子を外す", () => {
  it("claimForAi：請求 id・診療年月・過去月の算定だけを写す。請求にあとから足された項目は送らない", () => {
    const ctx = instance.runAs(user, () => instance.getApp().caseOf(claimId("K6")));
    const withExtras = { ...ctx, patient: { name: MARK.name, birth: MARK.birth }, clinic: { code: MARK.clinicCode }, comments: [{ code: "830100001", text: MARK.extra, raw: MARK.extra, on: [] }] } as ClaimContext;
    const ai = outbound.claimForAi(withExtras);
    expect(Object.keys(ai).sort()).toEqual(["claimId", "history", "yearMonth"]);
    expect(ai).toEqual({ claimId: ctx.claimId, yearMonth: ctx.yearMonth, history: ctx.history });
    expect(JSON.stringify(ai)).not.toMatch(new RegExp(Object.values(MARK).join("|")));
  });

  it("AI に届く全部の経路（メンターのヒント・解説・自前のツール・ベテランのメンター・事実の読み取り・SOAP 整理・画像・整文・読みがな）で、目印と同梱の症例の識別子が、送る文・作業場所・ログ・監査ログに現れない", async () => {
    const me = instance.clerkIdOf(user);
    const note = { s: `動悸なし。${FREE_TEXT}`, o: "脈は不整", a: "AF", p: "DOAC 継続", rx: "DOAC" };
    await instance.runAs(user, async () => {
      const a = instance.getApp();
      a.importUke(me, "kokuhoren.UKE");
      // メンター：目印を入れた取り込みのレセプトと、照合の不一致がある同梱の症例（K4）。ヒントの段階と、確定したあとの解説
      for (const id of [uploaded, claimId("K4")]) {
        const q = a.start(me, id);
        await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: `ヒントをください。${FREE_TEXT}`, situation: "通常" });
        a.confirm(q.id, a.caseFor(q).lines);
        await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: "判定の理由を解説してください", situation: "新人の誤り" });
      }
      // 訪問の時点の問題（見込みの文を添える）
      const visit = a.visits(me).find((v) => v.claimId === claimId("K4"))!;
      const qv = a.start(me, claimId("K4"), "通常", visit.date);
      await instance.talkToMentor({ user, clerkId: me, questionId: qv.id, message: "この訪問で気をつけることは？", situation: "通常" });
      // カルテ：事実の読み取り（保存）・SOAP 整理・画像
      await instance.writeChart({ user, claimId: claimId("K4"), clerkId: me, kind: "訪問診療", note });
      await instance.formatChart(user, "動悸なし。AF。DOAC 継続");
      await instance.readChartFromImage(user, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
    });
    // 整文（代行入力）と、声で答えた名前の読みがな
    const { tidy } = await import("../../src/mentor/scribe");
    await tidy(user, "本日訪問。変わりなし");
    const { toHiragana } = await import("../../src/voice/kana");
    await toHiragana(user, "山田");

    // 行ったこと（acts）の取り出しも、この経路の 1 回の呼び出しに入っている（段 18a。§11-11 のテストに acts の呼び出しを足す）
    expect(sdk.calls.some((c) => "acts" in (((c.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object))).toBe(true);
        // 送ったもの：プロンプト・指示（システムプロンプト）・ツールの返事
    const roles = sdk.calls.map((c) => Object.keys(((c.options.outputFormat as { schema: { properties: object } }).schema.properties) as object).join(","));
    expect(new Set(roles).size).toBeGreaterThanOrEqual(7);
    expect(sdk.calls.length).toBeGreaterThanOrEqual(12);
    expect(sdk.toolResults.length).toBeGreaterThanOrEqual(30);
    const sentText = [...sdk.calls.map((c) => JSON.stringify([c.prompt, c.options.systemPrompt])), ...sdk.toolResults].join("\n");
    // メンターの作業場所（本人の CLAUDE.md と、読めるスキル）
    const workspace = contents(path.join(tmp, "ws")).join("\n");
    expect(workspace).toContain("CLAUDE.md");
    const audit = JSON.stringify(instance.runAs(user, () => instance.getApp().audit.list(500)));
    // 取りこぼしていないことの確かめ：利用者が打ち込んだ文（外せないもの）は、送る文にそのまま入っている。請求 id（アプリの番号）も入っている
    expect(sentText).toContain(FREE_TEXT);
    expect(sentText).toContain(uploaded);

    // 同梱の症例の識別子（合成の値）も、目印と同じに扱う
    const bundled = JSON.parse(readFileSync(path.join(repo, "fixtures", "uke", "patients.json"), "utf8")) as { clinic: { code: string; name: string; phone: string }; patients: Record<string, UkePatient> };
    const identifiers = [
      ...Object.values(MARK),
      bundled.clinic.code,
      bundled.clinic.phone,
      ...Object.values(bundled.patients).flatMap((p) => [p.name, p.name.replace(/\s/g, ""), p.birth, p.insurer.number, p.insurer.symbol, p.insurer.no, ...p.kohi.flatMap((k) => [k.payerNo, k.recipientNo])]),
    ].filter((v) => v.length >= 4);
    expect(identifiers.length).toBeGreaterThan(30);
    for (const [where, text] of [["送る文", sentText], ["作業場所", workspace], ["ログ", logs.join("\n")], ["監査ログ", audit]] as const) {
      expect([where, identifiers.filter((v) => text.includes(v))]).toEqual([where, []]);
    }
    // ログには、利用者が打ち込んだ文も出さない
    expect(logs.join("\n")).not.toContain(FREE_TEXT);
    expect(audit).not.toContain(FREE_TEXT);
  });
});

describe("送る前の確認", () => {
  it("利用者は、今の版の注意書きに同意していなければ送れない（呼ぶたびに DB を見る）。利用者でない値・印をまねた値も通らない", async () => {
    const auth = instance.getAuth();
    const before = sdk.calls.length;
    const stranger = { id: "t000000000000", login: "x", name: "x", tenantId: "t000000000000", role: "clerk" } as User;
    for (const by of [stranger, { bundled: true }, null, undefined, {}] as unknown as User[]) {
      expect(() => outbound.assertMaySend(by)).toThrow(ConsentRequired);
      await expect(outbound.runOnce(by, "test", "送らない文", {})).rejects.toThrow(ConsentRequired);
    }
    // 同意の記録を消す（注意書きの版が上がったのと同じ状態）と、同じ利用者でも次の呼び出しから送れない
    await outbound.runOnce(user, "test", "送る文", { outputFormat: { type: "json_schema", schema: { type: "object", properties: { s: {} } } } });
    expect(sdk.calls.length).toBe(before + 1);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(tmp, "auth.db"));
    db.prepare("UPDATE users SET accepted_notice_version = '0' WHERE id = ?").run(user.id);
    db.close();
    await expect(outbound.runOnce(user, "test", "送らない文", {})).rejects.toThrow(ConsentRequired);
    const { speak, listen } = await import("../../src/voice/elevenlabs");
    await expect(speak(user, "voice", "こんにちは")).rejects.toThrow(ConsentRequired);
    await expect(listen(user, new Blob([new Uint8Array(8)]))).rejects.toThrow(ConsentRequired);
    expect(sdk.calls.length).toBe(before + 1);
    expect(auth.acceptedNotice(user.id)).toBe(false);
    // 利用者のいない呼び出しの入口はない：利用者の形をしていない値は、どれも送れない
    for (const by of [null, undefined, {}, { bundled: true }]) expect(() => outbound.assertMaySend(by as unknown as User)).toThrow(ConsentRequired);
  });
});
