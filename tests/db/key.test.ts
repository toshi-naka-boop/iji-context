// 鍵と、鍵つきでデータベースを開くこと（spec FR-212・FR-215・FR-216）。テストの鍵は、その場で作る
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DataKeyError, deriveKey, masterKey } from "../../src/db/key";
import { appPurposeOf, dbFileState, openDatabase, PlaintextFoundError } from "../../src/db/open";

const tmp = mkdtempSync(path.join(tmpdir(), "iji-key-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const newKey = () => randomBytes(32);
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const MARK = "目印鍵子甲";

describe("親鍵と用途ごとの鍵", () => {
  it("環境変数は 16 進 64 文字だけを受け取る。ないときは null（平文で動く）", () => {
    expect(masterKey({})).toBeNull();
    expect(masterKey({ RESEMEN_DATA_KEY: "" })).toBeNull();
    const hex = newKey().toString("hex");
    expect(masterKey({ RESEMEN_DATA_KEY: hex })?.toString("hex")).toBe(hex);
    for (const bad of ["abc", hex.slice(2), `${hex}00`, `zz${hex.slice(2)}`]) expect(() => masterKey({ RESEMEN_DATA_KEY: bad })).toThrow(DataKeyError);
    // 誤りの文に、鍵の値を出さない
    try {
      masterKey({ RESEMEN_DATA_KEY: `${hex}0` });
    } catch (e) {
      expect(String(e)).not.toContain(hex);
    }
  });

  it("HKDF：同じ親鍵と用途には同じ鍵、用途か親鍵が違えば違う鍵（32 バイト）", () => {
    const m = newKey();
    const a = deriveKey("auth", m);
    expect(a.length).toBe(32);
    expect(deriveKey("auth", Buffer.from(m))).toEqual(a);
    const others = [deriveKey("app:t000000000001", m), deriveKey("app:t000000000002", m), deriveKey("files", m), deriveKey("auth", newKey())];
    expect(new Set([a, ...others].map((k) => k.toString("hex"))).size).toBe(5);
    expect(others.some((k) => k.equals(m))).toBe(false);
  });

  it("クリニックの app.db の用途は、置き場のフォルダの名前から決まる（退避した置き場も同じ）", () => {
    expect(appPurposeOf("/data/tenants/t0123456789ab/app.db")).toBe("app:t0123456789ab");
    expect(appPurposeOf("/data/tenants/t0123456789ab.retired-20261125T1000/app.db")).toBe("app:t0123456789ab");
    expect(appPurposeOf("/repo/data/resemen.db")).toBe("app:default");
  });
});

describe("鍵つきで開く", () => {
  it("鍵があれば暗号化して作る。中身（目印）も SQLite の印もファイルに出ず、同じ鍵で開き直せる", () => {
    const m = newKey();
    const f = path.join(tmp, "enc.db");
    const db = openDatabase(f, "auth", {}, m);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (x TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run(MARK);
    // WAL の中も暗号化される
    for (const s of ["", "-wal"]) expect(readFileSync(f + s).includes(Buffer.from(MARK))).toBe(false);
    db.close();
    expect(dbFileState(f)).toBe("encrypted");
    expect(readFileSync(f).subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    const again = openDatabase(f, "auth", { readonly: true }, m);
    expect(again.prepare("SELECT x FROM t").all()).toEqual([{ x: MARK }]);
    again.close();
  });

  it("違う鍵・違う用途・鍵なしでは開けず、誤りで止まる。ファイルは変わらない", () => {
    const m = newKey();
    const f = path.join(tmp, "enc2.db");
    const db = openDatabase(f, "app:t000000000001", {}, m);
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a')");
    db.close();
    const before = sha(f);
    expect(() => openDatabase(f, "app:t000000000001", {}, newKey())).toThrow(DataKeyError);
    expect(() => openDatabase(f, "app:t000000000002", {}, m)).toThrow(/合いません/);
    expect(() => openDatabase(f, "app:t000000000001", {}, null)).toThrow(/暗号化したデータベース/);
    expect(sha(f)).toBe(before);
  });

  it("鍵があるのに平文のデータベースなら、開かずに止め、移す手順を案内する（暗号化し直さない）", () => {
    const f = path.join(tmp, "plain.db");
    const p = openDatabase(f, "auth", {}, null);
    p.exec("CREATE TABLE t (x TEXT)");
    p.close();
    const before = sha(f);
    expect(dbFileState(f)).toBe("plain");
    expect(() => openDatabase(f, "auth", {}, newKey())).toThrow(PlaintextFoundError);
    expect(() => openDatabase(f, "auth", {}, newKey())).toThrow(/encrypt-at-rest/);
    expect(sha(f)).toBe(before);
  });

  it("鍵がなければ今までどおり平文の SQLite（ほかの道具でも読める）", () => {
    const f = path.join(tmp, "dev.db");
    const db = openDatabase(f, "app:default", {}, null);
    db.exec("CREATE TABLE t (x TEXT)");
    db.close();
    expect(readFileSync(f).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  });

  it("空のファイルは、ないものとして扱う", () => {
    const f = path.join(tmp, "empty.db");
    writeFileSync(f, "");
    expect(dbFileState(f)).toBe("missing");
    const db = openDatabase(f, "auth", {}, newKey());
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(dbFileState(f)).toBe("encrypted");
  });
});
