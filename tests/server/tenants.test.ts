// クリニックの DB ハンドル（src/server/instance.ts）：開いたままにする数に上限を置き、使われていない順に閉じる
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/server/auth";

let tmp: string;
let instance: typeof import("../../src/server/instance");
let users: User[];

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-tenants-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  users = ["a", "b", "c"].map((x) => instance.getAuth().register(`lru_${x}`, `りよう${x}`, "password123"));
  instance.setMaxOpenTenants(2);
});
afterAll(() => {
  instance.setMaxOpenTenants(50);
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

const appOf = (u: User) => instance.runAs(u, () => instance.getApp());

describe("クリニックの DB ハンドル", () => {
  it("上限を超えたら、いちばん長く使われていないクリニックを閉じる。閉じたクリニックは、次に使うときに開き直る", () => {
    const [a, b, c] = users;
    const first = appOf(a);
    instance.runAs(a, () => instance.getApp().advanceClock("2025-03-12T09:00:00+09:00"));
    appOf(b);
    appOf(a); // a を使い直したので、いちばん古いのは b
    const bApp = appOf(b);
    appOf(a);
    expect(instance.openTenantCount()).toBe(2);
    appOf(c);
    expect(instance.openTenantCount()).toBe(2);
    // b が閉じられ、a は開いたまま
    expect(() => bApp.now()).toThrow();
    expect(first.now()).toBe("2025-03-12T09:00:00+09:00");
    // b は取り直せば使える（今度は a が閉じられる）。データは残っている
    expect(appOf(b).now()).toBe("2025-03-10T09:00:00+09:00");
    expect(() => first.now()).toThrow();
    expect(appOf(a).now()).toBe("2025-03-12T09:00:00+09:00");
  });

  it("実行中の呼び出しがあるクリニックは、上限を超えていても閉じない（LLM の応答を待つ間もハンドルを使える）", async () => {
    const [a, b, c] = users;
    let release = () => {};
    const waiting = new Promise<void>((r) => (release = r));
    const running = instance.runAs(a, async () => {
      const held = instance.getApp();
      await waiting;
      return held.now();
    });
    appOf(b);
    appOf(c);
    appOf(b);
    release();
    await expect(running).resolves.toBe("2025-03-12T09:00:00+09:00");
    // 終わったあとは、ほかのクリニックと同じように閉じる対象になる
    appOf(b);
    appOf(c);
    expect(instance.openTenantCount()).toBe(2);
  });
});
