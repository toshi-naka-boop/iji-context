// scripts/reset-demo.ts：消すのは、データの置き場所（RESEMEN_DATA）の tenants/ のうち、デモのクリニックだけ。実在のデータで使うクリニックは消さない
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { targets } from "../../scripts/reset-demo";
import { openAuth } from "../../src/server/auth";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-reset-demo-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("reset-demo の消すもの", () => {
  it("渡したデータの置き場所の、demo のクリニック（退避したものを含む）と、その作業場所だけを挙げる。real と形の違うものは挙げない", () => {
    const data = path.join(tmp, "data");
    const ws = path.join(tmp, "ws");
    const auth = openAuth(path.join(data, "auth.db"));
    const demo = auth.register("reset_demo", "でも", "password123", "demo");
    const real = auth.register("reset_real", "じつ", "password123", "real");
    auth.close();
    const dirs = [
      path.join(data, "tenants", demo.tenantId),
      path.join(data, "tenants", `${demo.tenantId}.retired-20261122T000000`),
      path.join(data, "tenants", real.tenantId),
      path.join(data, "tenants", `${real.tenantId}.retired-20261122T000000`),
      path.join(data, "tenants", "something-else"),
      path.join(ws, "default"),
      path.join(ws, demo.tenantId),
      path.join(ws, real.tenantId),
    ];
    for (const d of dirs) mkdirSync(d, { recursive: true });

    const out = targets(data, ws);
    expect(out).toEqual(expect.arrayContaining([dirs[0], dirs[1], dirs[5], dirs[6]]));
    for (const keep of [dirs[2], dirs[3], dirs[4], dirs[7], path.join(data, "tenants"), ws]) expect(out).not.toContain(keep);
  });

  it("auth.db がない置き場所のクリニックは demo として扱う（種類を持つ前の置き場所）", () => {
    const data = path.join(tmp, "data");
    const dir = path.join(data, "tenants", "t0123456789ab");
    mkdirSync(dir, { recursive: true });
    expect(targets(data, path.join(tmp, "ws"))).toContain(dir);
  });
});
