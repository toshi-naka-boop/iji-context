// scripts/reset-demo.ts：消す・退避するのは、データの置き場所（RESEMEN_DATA）の auth.db で demo のクリニックだけ。
// 実在のデータで使うクリニックと、種類を確かめられないもの（auth.db がない・行がない・未定）は、消さない・退避しない
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retireCandidates, targets } from "../../scripts/reset-demo";
import { openAuth } from "../../src/server/auth";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-reset-demo-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** demo・real・未定（行を消したもの）のクリニックを 1 つずつ作り、置き場と作業場所を置く */
function setup() {
  const data = path.join(tmp, "data");
  const ws = path.join(tmp, "ws");
  const auth = openAuth(path.join(data, "auth.db"));
  const demo = auth.register("reset_demo", "でも", "password123", "demo").tenantId;
  const real = auth.register("reset_real", "じつ", "password123", "real").tenantId;
  const undecided = auth.register("reset_und", "みてい", "password123", "demo").tenantId;
  auth.close();
  const db = new Database(path.join(data, "auth.db"));
  db.prepare("DELETE FROM tenants WHERE id = ?").run(undecided);
  db.close();
  const t = (name: string) => path.join(data, "tenants", name);
  for (const id of [demo, real, undecided]) {
    mkdirSync(t(id), { recursive: true });
    mkdirSync(t(`${id}.retired-20261122T000000`), { recursive: true });
    mkdirSync(path.join(ws, id), { recursive: true });
  }
  mkdirSync(t("something-else"), { recursive: true });
  mkdirSync(path.join(ws, "default"), { recursive: true });
  return { data, ws, demo, real, undecided, t };
}

describe("reset-demo の消すもの", () => {
  it("demo のクリニック（退避したものを含む）と、その作業場所だけを挙げる。real・未定・形の違うものは挙げない", () => {
    const { data, ws, demo, real, undecided, t } = setup();
    const out = targets(data, ws);
    expect(out).toEqual(expect.arrayContaining([t(demo), t(`${demo}.retired-20261122T000000`), path.join(ws, "default"), path.join(ws, demo)]));
    for (const id of [real, undecided]) for (const keep of [t(id), t(`${id}.retired-20261122T000000`), path.join(ws, id)]) expect(out).not.toContain(keep);
    for (const keep of [t("something-else"), path.join(data, "tenants"), ws]) expect(out).not.toContain(keep);
  });

  it("auth.db がない置き場所では、種類を確かめられないので、クリニックの置き場も作業場所も挙げない", () => {
    const data = path.join(tmp, "data");
    const ws = path.join(tmp, "ws");
    const dir = path.join(data, "tenants", "t0123456789ab");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(ws, "t0123456789ab"), { recursive: true });
    const out = targets(data, ws);
    expect(out).not.toContain(dir);
    expect(out).not.toContain(path.join(ws, "t0123456789ab"));
  });

  it("--retire-stale の候補も、印が違う demo のクリニックだけ（real・未定は退避しない。auth.db がなければ候補なし）", () => {
    const { data, demo } = setup();
    // どの置き場にも app.db がない（印がない）ので、印の上では全部が古い
    expect(retireCandidates(data).map((c) => path.basename(c.dir))).toEqual([demo]);
    expect(retireCandidates(path.join(tmp, "nowhere"))).toEqual([]);
  });
  it("--include-undecided では、未定（行のないもの）も候補に入る。real は入らない", () => {
    const { data, demo, undecided } = setup();
    expect(retireCandidates(data, true).map((c) => path.basename(c.dir)).sort()).toEqual([demo, undecided].sort());
  });
});
