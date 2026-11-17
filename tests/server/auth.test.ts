// ログイン（FR-72）と 1 人 1 クリニック（FR-73）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword, openAuth, Throttle, verifyPassword } from "../../src/server/auth";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-auth-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
});

describe("パスワード", () => {
  it("平文を残さず、同じパスワードでも毎回ちがうハッシュになり、照合できる", () => {
    const a = hashPassword("correct horse");
    const b = hashPassword("correct horse");
    expect(a).not.toContain("correct");
    expect(a).not.toBe(b);
    expect(verifyPassword("correct horse", a)).toBe(true);
    expect(verifyPassword("wrong horse", a)).toBe(false);
    expect(verifyPassword("x", "壊れた値")).toBe(false);
  });
});

describe("登録・ログイン・セッション", () => {
  it("登録してログインでき、セッションで本人が分かり、ログアウトで消える", () => {
    const auth = openAuth(path.join(tmp, "a1.db"));
    const u = auth.register("judge_1", "しんさ", "password123");
    expect(() => auth.register("judge_1", "別の人", "password123")).toThrow("使われています");
    expect(() => auth.register("ab", "x", "password123")).toThrow();
    expect(() => auth.register("judge_2", "x", "short")).toThrow();
    expect(auth.login("judge_1", "password123")?.id).toBe(u.id);
    // 招待なしで作った利用者は、自分のクリニックの持ち主で、ロールは事務
    expect(u).toMatchObject({ tenantId: u.id, role: "clerk" });
    expect(auth.login("judge_1", "nope-nope")).toBeNull();
    expect(auth.login("nobody", "password123")).toBeNull();
    const s = auth.createSession(u.id);
    expect(auth.userOfSession(s.token)?.name).toBe("しんさ");
    expect(auth.userOfSession("でたらめ")).toBeNull();
    auth.endSession(s.token);
    expect(auth.userOfSession(s.token)).toBeNull();
    auth.close();
  });
  it("期限の切れたセッションは使えない", () => {
    const auth = openAuth(path.join(tmp, "a2.db"));
    const u = auth.register("judge_9", "x", "password123");
    const s = auth.createSession(u.id, new Date("2025-01-01T00:00:00Z"));
    expect(auth.userOfSession(s.token, new Date("2025-03-01T00:00:00Z"))).toBeNull();
    auth.close();
  });
  it("期限の切れたセッションの行は、次にセッションを作るとき（ログイン・登録）にまとめて消える", () => {
    const file = path.join(tmp, "a3.db");
    const auth = openAuth(file);
    const u = auth.register("judge_8", "x", "password123");
    auth.createSession(u.id, new Date("2025-01-01T00:00:00Z"));
    auth.createSession(u.id, new Date("2025-01-02T00:00:00Z"));
    const count = () => {
      const db = new Database(file);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
      db.close();
      return n;
    };
    expect(count()).toBe(2);
    // 2 つとも期限（30 日）を過ぎたあとにログインすると、残るのは新しい 1 つだけ
    const s = auth.createSession(u.id, new Date("2025-03-01T00:00:00Z"));
    expect(count()).toBe(1);
    expect(auth.userOfSession(s.token, new Date("2025-03-02T00:00:00Z"))?.id).toBe(u.id);
    auth.close();
  });
  it("本番の cookie の名前には __Host- が付く。その条件（Secure・Path=/・Domain なし）を cookie が満たす", async () => {
    const { sessionCookie, clearCookie } = await import("../../src/server/http");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      expect((await import("../../src/server/auth-cookie")).SESSION_COOKIE).toBe("__Host-resemen_session");
      for (const set of [sessionCookie("tok", new Date("2025-04-01T00:00:00Z")), clearCookie()]) {
        expect(set).toContain("; Path=/;");
        expect(set).toContain("; Secure");
        expect(set).not.toMatch(/domain=/i);
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    expect((await import("../../src/server/auth-cookie")).SESSION_COOKIE).toBe("resemen_session");
  });
  it("失敗が続いたら、しばらく受け付けない", () => {
    const t = new Throttle(3, 1000);
    ["k", "k", "k"].forEach((k) => t.hit(k, 0));
    expect(t.blocked("k", 500)).toBe(true);
    expect(t.blocked("k", 1500)).toBe(false);
  });
});

describe("1 人 1 クリニック", () => {
  it("ログインした人ごとに別のクリニックが開き、時計もキャラも混ざらない", async () => {
    const { getApp, getAuth, runAs, clerkIdOf } = await import("../../src/server/instance");
    const a = getAuth().register("clinic_a", "えー", "password123");
    const b = getAuth().register("clinic_b", "びー", "password123");
    runAs(a, () => {
      getApp().advanceClock("2025-03-20T09:00:00+09:00");
      getApp().chooseCharacter(clerkIdOf(a), "d");
    });
    runAs(b, () => {
      expect(getApp().now()).toBe("2025-03-10T09:00:00+09:00");
      expect(getApp().characterChosen(clerkIdOf(b))).toBe(false);
      expect(getApp().clerk(clerkIdOf(b)).name).toBe("びー");
      expect(getApp().knowledgeList().length).toBeGreaterThan(0);
      // 新しいクリニックには、K6 の査定通知から作った地域ルールが 1 つ入っている（FR-79）
      expect(getApp().knowledgeList().filter((k) => k.layer === "地域")).toHaveLength(1);
    });
    runAs(a, () => {
      expect(getApp().now()).toBe("2025-03-20T09:00:00+09:00");
      expect(getApp().clerk(clerkIdOf(a)).character_id).toBe("d");
    });
  });
});
