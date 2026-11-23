// 段 19a（design.md §16-1「AI に送らない」・§11-11）：構造化データは AI に送らない。
// (1) src/structured/** は LLM の SDK・メンター・AI に送る処理を import しない（§2-8 の不変条件 6 と同じ形）
// (2) AI に送る文脈を作るファイルは、構造化データの処理と表を読まない
// (3) 構造化データの各欄に目印の値を入れて残した患者で、AI に届く経路（カルテの取り出し・メンター・自前のツール）を通しても、送る文・ログ・監査ログに目印が現れない。AI は呼ばない
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StructuredChart } from "../../src/connect/types";
import type { User } from "../../src/server/auth";
import { autoConsent } from "../helpers/consent";
import { claimId, day, YM } from "../helpers/period";
import type { SdkCall } from "../helpers/sdk";

const repo = path.join(__dirname, "..", "..");
const filesIn = (d: string): string[] =>
  readdirSync(path.join(repo, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
const importsOf = (f: string) => [...readFileSync(path.join(repo, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);

describe("依存の検査", () => {
  it("src/structured/** は LLM の SDK・src/llm・src/mentor を import しない", () => {
    const files = filesIn("src/structured");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) for (const i of importsOf(f)) expect(/@anthropic-ai|claude-agent-sdk|(^|\/)llm(\/|$)|(^|\/)mentor(\/|$)/.test(i), `${f}: ${i}`).toBe(false);
  });
  it("AI に送る文脈を作るファイル（src/llm・src/mentor・src/query・カルテの取り出し・SOAP・画像）は、構造化データの処理と表を読まない", () => {
    const files = [...filesIn("src/llm"), ...filesIn("src/mentor"), ...filesIn("src/query"), "src/chart/extract.ts", "src/chart/soap.ts", "src/chart/image.ts"];
    for (const f of files) {
      for (const i of importsOf(f)) expect(/structured/.test(i), `${f}: ${i}`).toBe(false);
      expect(/chart_structured|structured_inputs|ext_code_maps|readStructured|StructuredChart/.test(readFileSync(path.join(repo, f), "utf8")), f).toBe(false);
    }
  });
});

const sdk = vi.hoisted(() => ({ calls: [] as SdkCall[], toolResults: [] as string[] }));
async function respond(call: SdkCall): Promise<{ structured: unknown }> {
  const props = Object.keys(((call.options.outputFormat as { schema?: { properties?: object } } | undefined)?.schema?.properties ?? {}) as object);
  const server = (call.options.mcpServers as Record<string, { instance: unknown }> | undefined)?.resemen;
  if (server) {
    const tools = (server.instance as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> })._registeredTools;
    // 医師確認（ask_doctor）も、メンターの自前のツールの返事として AI に届く
    const doctor = { field: "病型", why: "記載がない", question: "病型について、該当するものを選んでください。", indicators: [{ source: "カルテ", text: "AF" }], options: ["発作性", "持続性", "その他", "判定不能"] };
    for (const [name, a] of Object.entries({ query_history: {}, ask_doctor: doctor, ask_missing: { target: "clerk", field: "要介護度", why: "記載がない" } })) sdk.toolResults.push(JSON.stringify(await tools[name].handler(a, {})));
  }
  if (props.includes("expression")) return { structured: { body: "見るとよい場所があります。", expression: "通常", citedKnowledge: [], topic: "算定" } };
  if (props.includes("facts")) return { structured: { facts: [], acts: [{ category: "投薬", written: "DOAC", lookup: ["DOAC"], quote: "DOAC 継続" }], rx: [{ quote: "DOAC" }] } };
  return { structured: null };
}
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), respond, sdk.calls));

/** 目印（どれも、ほかの文に偶然は現れない並び）。構造化データの全部の欄に入れる */
const MARK = { ref: "MKREF7731", time: "07:13", localCode: "MKLOCAL5519", drugName: "目印の薬甲", yj: "7713MK5519AB", rece: "771355193", actName: "目印の処置乙", item: "目印の器材丙", unit: "目印単位", qty: "77錠", kind: "目印の指導管理丁", device: "目印の機器戊" };
const marked: StructuredChart = {
  visits: { status: "supported", items: [{ ref: `${MARK.ref}v`, date: day(3), start: MARK.time, end: MARK.time, kind: "訪問診療" }], gaps: {} },
  orders: { status: "supported", items: [{ ref: `${MARK.ref}o`, date: day(3), place: "院内", refills: 7, drugs: [{ code: { system: "yj", value: MARK.yj }, name: MARK.drugName, days: 77, quantity: MARK.qty }] }], gaps: {} },
  procedures: { status: "supported", items: [{ ref: `${MARK.ref}p`, date: day(3), act: { code: { system: "local", value: MARK.localCode }, name: MARK.actName }, count: 1, items: [{ kind: "器材", code: { system: "rece", value: MARK.rece }, name: MARK.item, quantity: 7, unit: MARK.unit }] }], gaps: {} },
  homeCare: { status: "supported", items: [{ ref: `${MARK.ref}h`, kind: { code: null, name: MARK.kind }, devices: [{ code: { system: "local", value: MARK.localCode }, name: MARK.device, startedOn: day(1), endedOn: null }], startedOn: day(1) }], gaps: {} },
};

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
const logs: string[] = [];
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-structured-noai-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("structured_noai", "めじるし", "password123");
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

describe("目印の値（§11-11）", () => {
  it("構造化データの各欄に目印を入れて残した患者で、カルテの取り出し・メンター・医師確認（自前のツール）に送る文、ログ、監査ログに目印が現れない", async () => {
    const me = instance.clerkIdOf(user);
    const id = claimId("K4");
    await instance.runAs(user, async () => {
      const a = instance.getApp();
      const pid = a.structuredPatientOf(id);
      a.saveStructured(pid, YM, "fixture", marked);
      // 読み出し（画面に出す側）には目印が出る：取りこぼしでないことの確かめ
      expect(JSON.stringify(await a.chartStructured(pid, YM))).toContain(MARK.drugName);
      await instance.writeChart({ user, claimId: id, clerkId: me, kind: "訪問診療", note: { s: "動悸なし", o: "脈は不整", a: "AF", p: "DOAC 継続", rx: "DOAC" } });
      const q = a.start(me, id);
      await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: "ヒントをください", situation: "通常" });
    });
    expect(sdk.calls.length).toBeGreaterThanOrEqual(2);
    expect(sdk.toolResults.length).toBe(3);
    const sent = [...sdk.calls.map((c) => JSON.stringify([c.prompt, c.options.systemPrompt])), ...sdk.toolResults].join("\n");
    const audit = JSON.stringify(instance.runAs(user, () => instance.getApp().audit.list(500)));
    const pattern = new RegExp(Object.values(MARK).join("|"));
    expect(sent).not.toMatch(pattern);
    expect(logs.join("\n")).not.toMatch(pattern);
    expect(audit).not.toMatch(pattern);
  });
});
