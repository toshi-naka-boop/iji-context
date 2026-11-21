// 完了条件 (h)（design.md §11-11・C-97）：ルートの申告を "none" に書き換えても、同意のない利用者の入力は外に出ない。
// 権限表の全行の申告を「外部へ送らない・患者の情報を扱わない」に書き換えてから、実際のルート（AI・音声に届くもの）を、
// 同意していない利用者で呼ぶ。route() は止めないが、外部へ送る直前の確認（src/llm/outbound.ts の assertMaySend）が止める。
// AI・音声は呼ばない（SDK を差し替え、呼ばれた回数を見る）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import NOTICE from "../../config/notice.json";
import type { User } from "../../src/server/auth";
import { CONSENT_MESSAGE } from "../../src/server/errors";
import { POLICY } from "../../src/server/policy";
import { resetLimits } from "../../src/server/rate-limit";
import { claimId } from "../helpers/period";

const sent = vi.hoisted(() => ({ ai: vi.fn(), voice: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => (await import("../helpers/sdk")).fakeSdk(await original<object>(), sent.ai));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = { convert: sent.voice };
    speechToText = { convert: sent.voice };
  },
}));

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");
let user: User;
let cookie: string;
let questionId: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-declared-none-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  // ルートを読み込む前に、申告を書き換える（ルートは読み込みの時点で allow() を引く）
  for (const key of Object.keys(POLICY) as (keyof typeof POLICY)[]) Object.assign(POLICY[key], { external: "none", patientData: false });
  instance = await import("../../src/server/instance");
  user = instance.getAuth().register("declared_none", "しんこく", "password123");
  // 通知の読み取りはベテランだけ。1 人で使っているクリニックなので、ベテランに切り替えておく（算定の操作もできる）
  user = instance.getAuth().switchRole(user, "veteran");
  cookie = `resemen_session=${instance.getAuth().createSession(user.id).token}`;
  questionId = instance.runAs(user, () => instance.getApp().start(instance.clerkIdOf(user), claimId("K1")).id);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});
beforeEach(() => {
  resetLimits();
  sent.ai.mockReset();
  sent.voice.mockReset();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const NOTE = { s: "動悸なし", o: "脈は不整", a: "AF。心不全は落ち着いている", p: "DOAC 継続", rx: "DOAC" };
const json = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const audio = () => {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(64)]), "name.webm");
  return new Request("http://localhost/api/voice/listen", { method: "POST", headers: { cookie }, body: form });
};
type Handler = (req: Request) => Promise<Response>;
const load = async (url: string, method = "POST") => ((await import(path.join(repo, "app", url, "route.ts"))) as Record<string, Handler>)[method];

/** AI・音声に届くルートと、通る入力。to は、同意があれば届く先 */
const calls: { key: string; to: "ai" | "voice"; run: () => Promise<Response> }[] = [
  { key: "POST /api/chart", to: "ai", run: async () => (await load("/api/chart"))(json("/api/chart", { claimId: claimId("K4"), kind: "訪問診療", note: NOTE })) },
  { key: "POST /api/chart/soap", to: "ai", run: async () => (await load("/api/chart/soap"))(json("/api/chart/soap", { text: "動悸なし。AF。DOAC 継続" })) },
  { key: "POST /api/chart/image", to: "ai", run: async () => (await load("/api/chart/image"))(json("/api/chart/image", { imageBase64: PNG.toString("base64") })) },
  { key: "POST /api/mentor", to: "ai", run: async () => (await load("/api/mentor"))(json("/api/mentor", { questionId, message: "ヒントをください", situation: "通常" })) },
  { key: "POST /api/proxy", to: "ai", run: async () => (await load("/api/proxy"))(json("/api/proxy", { claimId: claimId("K1"), text: "本日訪問。変わりなし" })) },
  { key: "POST /api/notice", to: "ai", run: async () => (await load("/api/notice"))(json("/api/notice", { sample: true })) },
  { key: "POST /api/voice/speak", to: "voice", run: async () => (await load("/api/voice/speak"))(json("/api/voice/speak", { characterId: "a", line: "intro" })) },
  { key: "POST /api/voice/listen", to: "voice", run: async () => (await load("/api/voice/listen"))(audio()) },
  { key: "GET /api/sdk-check", to: "ai", run: async () => (await load("/api/sdk-check", "GET"))(new Request("http://localhost/api/sdk-check", { headers: { cookie } })) },
  { key: "GET /api/mentor-check", to: "ai", run: async () => (await load("/api/mentor-check", "GET"))(new Request("http://localhost/api/mentor-check", { headers: { cookie } })) },
  { key: "GET /api/mentor-check?peer", to: "ai", run: async () => (await load("/api/mentor-check", "GET"))(new Request(`http://localhost/api/mentor-check?peer=${encodeURIComponent("在医総管の区分は？")}`, { headers: { cookie } })) },
];

describe("申告を none に書き換えても、同意のない利用者の入力は outbound から出ない", () => {
  it("書き換えた申告では route() は止めない（どの行も、外部へ送らない・患者の情報を扱わないと申告している）", async () => {
    expect(Object.values(POLICY).every((r) => r.external === "none" && r.patientData === false)).toBe(true);
    // 患者の情報を返すルートが、同意なしで通ってしまう（申告が漏れた状態を再現できている）
    expect((await (await load("/api/cases", "GET"))(new Request("http://localhost/api/cases", { headers: { cookie } }))).status).toBe(200);
  });

  it("同意していない利用者：AI・音声に届くルートを 1 つずつ呼んでも、何も送られず、同意を求める応答になる", async () => {
    for (const c of calls) {
      resetLimits();
      const res = await c.run();
      const body = (await res.json().catch(() => ({}))) as { error?: string; consent?: string };
      // 開発用の確認の入口は、例外を自分で受けて 500 と文言を返す。ほかは 403 と印
      const dev = c.key.startsWith("GET /api/");
      expect([c.key, res.status, body.error, body.consent]).toEqual([c.key, dev ? 500 : 403, CONSENT_MESSAGE, dev ? undefined : "required"]);
      expect([c.key, sent.ai.mock.calls.length, sent.voice.mock.calls.length]).toEqual([c.key, 0, 0]);
    }
  });

  it("同じ呼び出しは、同意したあとなら外へ届く（上の検査が、届くはずの経路を見ていることの確かめ）", async () => {
    instance.getAuth().acceptNotice(user.id, NOTICE.version);
    for (const c of calls) {
      resetLimits();
      sent.ai.mockReset();
      sent.voice.mockReset();
      // 返事の中身は見ない（形の違う返事で落ちてもよい）。送ったかどうかだけを見る
      await c.run().catch(() => null);
      expect([c.key, c.to, (c.to === "ai" ? sent.ai : sent.voice).mock.calls.length > 0]).toEqual([c.key, c.to, true]);
    }
  });
});
