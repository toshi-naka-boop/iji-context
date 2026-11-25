// 起動時の確かめ（spec FR-216）：本番で鍵がない・鍵が違う・鍵があるのに平文のデータがあるときは止める。データベースは変えない
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DataKeyError } from "../../src/db/key";
import { openDatabase, PlaintextFoundError } from "../../src/db/open";
import { assertAtRest } from "../../src/server/at-rest";

const tmp = mkdtempSync(path.join(tmpdir(), "iji-at-rest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const hex = () => randomBytes(32).toString("hex");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
let n = 0;
/** 置き場とアプリのフォルダを新しく作る */
function place() {
  const dir = path.join(tmp, `p${++n}`);
  const data = path.join(dir, "data");
  mkdirSync(data, { recursive: true });
  return { data, root: dir };
}
/** auth.db を作る（key が null なら平文） */
function makeAuth(data: string, key: string | null) {
  const db = openDatabase(path.join(data, "auth.db"), "auth", {}, key ? Buffer.from(key, "hex") : null);
  db.exec("CREATE TABLE users (id TEXT)");
  db.close();
}
const prodEnv = (key?: string) => ({ NODE_ENV: "production", ...(key ? { RESEMEN_DATA_KEY: key } : {}), CLAUDE_CONFIG_DIR: path.join(tmp, "sdk") });

describe("起動時の確かめ", () => {
  it("本番の設定で鍵がなければ止まる。開発・テストは鍵がなくても平文で動く", () => {
    const p = place();
    expect(() => assertAtRest(prodEnv(), p)).toThrow(DataKeyError);
    expect(() => assertAtRest(prodEnv(), p)).toThrow(/鍵（RESEMEN_DATA_KEY）がなければ起動しません/);
    expect(assertAtRest({ NODE_ENV: "development" }, p)).toEqual({ encrypted: false });
    expect(assertAtRest({ NODE_ENV: "test" }, p)).toEqual({ encrypted: false });
  });

  it("鍵が合えば通る。違う鍵では止まり、auth.db は変わらない", () => {
    const p = place();
    const key = hex();
    makeAuth(p.data, key);
    const file = path.join(p.data, "auth.db");
    const before = sha(file);
    expect(assertAtRest(prodEnv(key), p)).toEqual({ encrypted: true });
    expect(() => assertAtRest(prodEnv(hex()), p)).toThrow(/合いません/);
    expect(sha(file)).toBe(before);
  });

  it("鍵の形が違えば止まる（黙って平文にしない）", () => {
    expect(() => assertAtRest({ RESEMEN_DATA_KEY: "1234" }, place())).toThrow(DataKeyError);
  });

  it("鍵があるのに平文のデータベースがあれば止め、移す手順を案内する。ファイルは変えない", () => {
    const p = place();
    makeAuth(p.data, null);
    const file = path.join(p.data, "auth.db");
    const before = sha(file);
    expect(() => assertAtRest(prodEnv(hex()), p)).toThrow(PlaintextFoundError);
    expect(sha(file)).toBe(before);
    // クリニックの app.db と、開発用の data/resemen.db も見る
    const q = place();
    const key = hex();
    makeAuth(q.data, key);
    const tenant = path.join(q.data, "tenants", "t0123456789ab");
    mkdirSync(tenant, { recursive: true });
    openDatabase(path.join(tenant, "app.db"), "app:t0123456789ab", {}, null).exec("CREATE TABLE t (x)");
    expect(() => assertAtRest(prodEnv(key), q)).toThrow(/tenants\/t0123456789ab\/app\.db/);
  });

  it("本番で鍵があるとき、会話の記録の手元の写し（CLAUDE_CONFIG_DIR）がないか、データの置き場の中なら止める", () => {
    const p = place();
    const key = hex();
    expect(() => assertAtRest({ NODE_ENV: "production", RESEMEN_DATA_KEY: key }, p)).toThrow(/CLAUDE_CONFIG_DIR/);
    expect(() => assertAtRest({ NODE_ENV: "production", RESEMEN_DATA_KEY: key, CLAUDE_CONFIG_DIR: path.join(p.data, "home", ".claude") }, p)).toThrow(/置き場の中/);
    expect(assertAtRest(prodEnv(key), p)).toEqual({ encrypted: true });
  });
});
