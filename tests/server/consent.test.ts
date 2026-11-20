// 注意書きへの同意（design.md §11-11。完了条件 (a)）：外部へ送るか患者の情報を扱うルートは、今の版の注意書きに同意していなければ 403。
// 権限表を回して確かめる：共通のルートヘルパ（route）が申告どおりに止めることと、実際のルート（app/api/**/route.ts）が 1 つ残らず止まること。
// AI・音声は呼ばない（SDK を差し替え、呼ばれていないことも確かめる）
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import NOTICE from "../../config/notice.json";
import type { User } from "../../src/server/auth";
import { CONSENT_MESSAGE } from "../../src/server/errors";
import { allow, POLICY, rolesOf, type PolicyKey } from "../../src/server/policy";
import { resetLimits } from "../../src/server/rate-limit";
import type { Role } from "../../src/server/roles";
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
let http: typeof import("../../src/server/http");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-consent-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  http = await import("../../src/server/http");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const auth = () => instance.getAuth();
const cookieOf = (u: User) => `resemen_session=${auth().createSession(u.id).token}`;
const keys = Object.keys(POLICY) as PolicyKey[];
/** 同意が要る行（外部へ送るか、患者の情報を扱う） */
const gated = keys.filter((k) => POLICY[k].external !== "none" || POLICY[k].patientData);
const open = keys.filter((k) => !gated.includes(k));
/** その行を通れるロール（開発用はどのロールでも通る） */
const roleFor = (key: PolicyKey): Role => rolesOf(POLICY[key].rule)[0];
const request = (key: PolicyKey, cookie: string) => {
  const [method, url] = key.split(" ");
  return new Request(`http://localhost${url}`, { method, headers: { cookie } });
};
const consentOf = async (res: Response) => ({ status: res.status, ...((await res.json().catch(() => ({}))) as { error?: string; consent?: string }) });

describe("ルートの申告と同意（権限表を回す）", () => {
  it("同意が要る行と要らない行が、両方ある（表の読み違いで全部が片方に寄っていない）", () => {
    expect(gated.length).toBeGreaterThan(40);
    expect(open.length).toBeGreaterThan(15);
  });

  it("route()：同意が要る行は、同意していない利用者には 403 と印を返し、処理に入らない。同意すると通る", async () => {
    const user = auth().register("consent_table", "どうい", "password123");
    const cookie = cookieOf(user);
    const handler = vi.fn(() => ({ ok: true }));
    for (const key of gated) {
      auth().switchRole(user, roleFor(key));
      const r = await consentOf(await http.route({ roles: allow(key) }, handler)(request(key, cookie)));
      expect([key, r.status, r.consent, r.error]).toEqual([key, 403, "required", CONSENT_MESSAGE]);
    }
    expect(handler).not.toHaveBeenCalled();
    // 同意が要らない行は、同意していなくても通る
    for (const key of open.filter((k) => POLICY[k].rule !== "public" && rolesOf(POLICY[k].rule).length > 0)) {
      auth().switchRole(user, roleFor(key));
      expect([key, (await http.route({ roles: allow(key) }, handler)(request(key, cookie))).status]).toEqual([key, 200]);
    }
    const before = handler.mock.calls.length;
    auth().acceptNotice(user.id, NOTICE.version);
    for (const key of gated) {
      auth().switchRole(user, roleFor(key));
      expect([key, (await http.route({ roles: allow(key) }, handler)(request(key, cookie))).status]).toEqual([key, 200]);
    }
    expect(handler.mock.calls.length - before).toBe(gated.length);
    // 断った操作は、監査ログに denied として残る（GET 以外）
    const log = instance.runAs(user, () => instance.getApp().audit.list(500));
    const denied = gated.filter((k) => !k.startsWith("GET "));
    expect(log.filter((l) => l.result === "denied" && l.status === 403).map((l) => l.action).sort()).toEqual([...denied].sort());
  });

  it("実際のルート：同意が要る行のルートを 1 つずつ呼ぶと、どれも 403 と印で止まり、AI・音声は呼ばれない", async () => {
    const user = auth().register("consent_routes", "るーと", "password123");
    const cookie = cookieOf(user);
    // パスの [id] などに入れる候補（どれかがそのルートの形に合う。合わない候補は 400 で落ちる）
    const candidates = ["q0001", "q-0123456789ab", "1", "P0001", claimId("K1"), "a".repeat(64)];
    for (const key of gated) {
      resetLimits();
      auth().switchRole(user, roleFor(key));
      const [method, url] = key.split(" ");
      const mod = (await import(path.join(repo, "app", url, "route.ts"))) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
      const names = [...url.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      const tries = names.length === 0 ? [{}] : candidates.map((c) => Object.fromEntries(names.map((n) => [n, c])));
      const results = [];
      for (const p of tries) results.push(await consentOf(await mod[method](request(key, cookie), { params: Promise.resolve(p) })));
      // 形に合わない候補は 400。合う候補は、同意の確認で止まる。通ってしまう候補は 1 つもない
      expect([key, results.every((r) => r.status === 400 || (r.status === 403 && r.consent === "required"))]).toEqual([key, true]);
      expect([key, results.some((r) => r.status === 403 && r.consent === "required")]).toEqual([key, true]);
    }
    expect(sent.ai).not.toHaveBeenCalled();
    expect(sent.voice).not.toHaveBeenCalled();
  });
});

describe("同意する", () => {
  const consent = async (cookie: string | null, body: unknown) =>
    (await import("../../app/api/consent/route")).POST(new Request("http://localhost/api/consent", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }));
  const cases = async (cookie: string) => (await import("../../app/api/cases/route")).GET(new Request("http://localhost/api/cases", { headers: { cookie } }));
  const row = (u: User) => {
    const db = new Database(path.join(tmp, "auth.db"), { readonly: true });
    try {
      return db.prepare("SELECT accepted_notice_version AS version, accepted_notice_at AS at FROM users WHERE id = ?").get(u.id) as { version: string | null; at: string | null };
    } finally {
      db.close();
    }
  };

  it("未ログインは 401。同意すると、利用者の行に版と時刻が入り、監査ログに残り、止まっていた操作が通る", async () => {
    expect((await consent(null, { version: NOTICE.version })).status).toBe(401);
    const user = auth().register("consent_accept", "ほんにん", "password123");
    const cookie = cookieOf(user);
    expect(row(user)).toEqual({ version: null, at: null });
    expect(await consentOf(await cases(cookie))).toMatchObject({ status: 403, consent: "required" });

    // 誰の同意かは本文で受け取らない（知らない項目は断る）
    expect((await consent(cookie, { version: NOTICE.version, userId: "t000000000000" })).status).toBe(400);
    // 画面が持っている版が古ければ、同意にしない
    expect((await consent(cookie, { version: "0" })).status).toBe(409);
    expect(row(user).version).toBeNull();

    const ok = await consent(cookie, { version: NOTICE.version });
    expect([ok.status, await ok.json()]).toEqual([200, { version: NOTICE.version }]);
    expect(row(user).version).toBe(NOTICE.version);
    expect(row(user).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await cases(cookie)).status).toBe(200);

    const log = instance.runAs(user, () => instance.getApp().audit.list(50));
    expect(log.find((l) => l.action === "POST /api/consent" && l.result === "ok")).toMatchObject({ userId: user.id, target: NOTICE.version, status: 200 });
    expect(auth().eventsOf(user.tenantId).some((e) => e.event === `notice.accept:${NOTICE.version}` && e.userId === user.id)).toBe(true);
  });

  it("同意は利用者ごと・版ごと：ほかの人の同意では通らず、前の版への同意では通らない", async () => {
    const a = auth().register("consent_a", "えー", "password123");
    const b = auth().registerWithInvite("consent_b", "びー", "password123", auth().createInvite(a, "veteran").code);
    expect((await consent(cookieOf(a), { version: NOTICE.version })).status).toBe(200);
    expect(await consentOf(await cases(cookieOf(b)))).toMatchObject({ status: 403, consent: "required" });
    // 注意書きの版が上がったあと（前の版に同意した記録だけが残っている状態）は、もう一度聞かれる
    const db = new Database(path.join(tmp, "auth.db"));
    db.prepare("UPDATE users SET accepted_notice_version = '0' WHERE id = ?").run(a.id);
    db.close();
    expect(await consentOf(await cases(cookieOf(a)))).toMatchObject({ status: 403, consent: "required" });
  });
});
