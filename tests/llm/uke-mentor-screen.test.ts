// 取り込んだレセプトの点検の画面のメンター（採点 r3 医療事務課長 #2）：画面から聞いたとき（screen: "uke"）は、その画面に出ている指摘（摘要欄の R17 を含む）がメンターへの文に入る。
// 画面の外から聞いたときは入らない。患者の氏名・保険者番号は入らない（FR-167）。AI は呼ばない（SDK を差し替え、送られたものをためる）
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { User } from "../../src/server/auth";
import { readUke } from "../../src/uke/uke";
import { autoConsent } from "../helpers/consent";
import type { SdkCall } from "../helpers/sdk";

const repo = path.join(__dirname, "..", "..");
const sdk = vi.hoisted(() => ({ calls: [] as SdkCall[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) =>
  (await import("../helpers/sdk")).fakeSdk(await original<object>(), () => ({ structured: { body: "見るとよい場所があります。", expression: "通常", citedKnowledge: [], topic: "算定" } }), sdk.calls),
);

let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
const bytes = readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE"));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-uke-mentor-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
  user = instance.getAuth().register("uke_mentor_owner", "やまだ", "password123");
  instance.runAs(user, () => instance.getApp().uploadUke(instance.clerkIdOf(user), bytes));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const sentOf = (c: SdkCall) => JSON.stringify([c.prompt, c.options.systemPrompt]);

describe("UKE の点検の画面のメンター", () => {
  it("画面から聞くと、画面の指摘（R17 の記載もれ）がメンターへの文に入る。画面の外からは入らない。氏名・保険者番号は入らない", async () => {
    const me = instance.clerkIdOf(user);
    await instance.runAs(user, async () => {
      const a = instance.getApp();
      // 画面に R17 の記載もれが確定で出ている請求
      expect((a.ukeCheck("U1-1", me) as { findings: { ruleId: string; kind: string }[] }).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R17", "記載もれ"]]);
      const q = a.start(me, "U1-1");
      await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: "摘要欄の記載もれが出ています。何を見ればよいですか", situation: "通常", screen: "uke" });
      const withScreen = sentOf(sdk.calls.at(-1)!);
      expect(withScreen).toContain("取り込んだレセプトの点検の画面");
      expect(withScreen).toMatch(/R17（記載もれ）/);
      await instance.talkToMentor({ user, clerkId: me, questionId: q.id, message: "ヒントをください", situation: "通常" });
      expect(sentOf(sdk.calls.at(-1)!)).not.toContain("取り込んだレセプトの点検の画面");
    });
    const p = readUke(bytes).receipts[0].patient;
    const sent = sdk.calls.map(sentOf).join("\n");
    expect(sent).not.toContain(p.name);
    expect(sent).not.toContain(p.insurer.number);
  });
});
