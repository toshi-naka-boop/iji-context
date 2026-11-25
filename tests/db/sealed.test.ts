// 患者情報が入るファイルを包む（spec FR-212）：AES-256-GCM。1 バイト変えると読み込みが誤りで止まる。鍵がなければ平文のまま
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DataKeyError } from "../../src/db/key";
import { PlaintextFoundError } from "../../src/db/open";
import { isSealed, readSealed, SealedFileError, writeSealed } from "../../src/db/sealed";
import { assertAtRest } from "../../src/server/at-rest";

const tmp = mkdtempSync(path.join(tmpdir(), "iji-sealed-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MARK = "目印封子乙";

describe("ファイルを包む", () => {
  it("鍵があれば包んで書き、同じ鍵で読める。中身（目印）はファイルに出ない", () => {
    const key = randomBytes(32);
    const f = path.join(tmp, "a.json");
    writeSealed(f, JSON.stringify({ name: MARK }), key);
    const raw = readFileSync(f);
    expect(isSealed(raw)).toBe(true);
    expect(raw.includes(Buffer.from(MARK))).toBe(false);
    expect(JSON.parse(readSealed(f, key).toString("utf8"))).toEqual({ name: MARK });
    // 同じ中身でも、書くたびに違うバイト列になる（IV が毎回違う）
    writeSealed(path.join(tmp, "b.json"), JSON.stringify({ name: MARK }), key);
    expect(readFileSync(path.join(tmp, "b.json")).equals(raw)).toBe(false);
  });

  it("包んだファイルを 1 バイト変えると、どの場所でも読み込みが誤りで止まる（黙って空にしない）", () => {
    const key = randomBytes(32);
    const f = path.join(tmp, "c.UKE");
    writeSealed(f, Buffer.from(`IR,${MARK}\r\n`), key);
    const raw = readFileSync(f);
    for (const at of [8, 12, 20, 28, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[at] ^= 0x01;
      writeFileSync(f, bad);
      expect(() => readSealed(f, key)).toThrow(SealedFileError);
    }
    // 短く切ったもの
    writeFileSync(f, raw.subarray(0, 20));
    expect(() => readSealed(f, key)).toThrow(SealedFileError);
  });

  it("違う鍵・別の名前に入れ替えたファイルは読めない", () => {
    const key = randomBytes(32);
    const f = path.join(tmp, "d.json");
    writeSealed(f, "x", key);
    expect(() => readSealed(f, randomBytes(32))).toThrow(SealedFileError);
    renameSync(f, path.join(tmp, "e.json"));
    expect(() => readSealed(path.join(tmp, "e.json"), key)).toThrow(SealedFileError);
  });

  it("鍵があるのに平文のファイルは読まずに止める。鍵がないのに包んだファイルも止める。鍵がなければ平文のまま書いて読む", () => {
    const f = path.join(tmp, "plain.json");
    writeSealed(f, "{}", null);
    expect(readFileSync(f, "utf8")).toBe("{}");
    expect(readSealed(f, null).toString()).toBe("{}");
    expect(() => readSealed(f, randomBytes(32))).toThrow(PlaintextFoundError);
    const g = path.join(tmp, "sealed.json");
    writeSealed(g, "{}", randomBytes(32));
    expect(() => readSealed(g, null)).toThrow(DataKeyError);
  });

  it("起動時の確かめは、鍵があるのに平文の UKE・医師確認の記録があれば止める", () => {
    const key = randomBytes(32).toString("hex");
    const data = path.join(tmp, "data");
    const dir = path.join(data, "tenants", "t0123456789ab", "query-log");
    mkdirSync(dir, { recursive: true });
    writeSealed(path.join(dir, "Q1.json"), "{}", Buffer.from(key, "hex"));
    expect(assertAtRest({ RESEMEN_DATA_KEY: key }, { data, root: tmp })).toEqual({ encrypted: true });
    writeFileSync(path.join(dir, "Q2.md"), `# ${MARK}`);
    expect(() => assertAtRest({ RESEMEN_DATA_KEY: key }, { data, root: tmp })).toThrow(/query-log\/Q2\.md/);
  });
});
