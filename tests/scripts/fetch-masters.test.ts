// scripts/fetch-masters.ts の、通信しない部分（公開ページからリンクを拾う・zip の中の名前の検査・接続先の一覧）。実際に落とす動作は、テストでは行わない
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { allowedHosts, extractCapped, linksOf, safeName } from "../../scripts/fetch-masters";
import { MASTERS_CONFIG } from "../../src/masters/config";

describe("fetch-masters", () => {
  it("接続先は、config/masters.json に書いてあるホストだけ", () => {
    expect([...allowedHosts()].sort()).toEqual(["shinryohoshu.mhlw.go.jp", "www.hpdx.or.jp"]);
    for (const ds of Object.values(MASTERS_CONFIG.datasets)) expect(ds.page.startsWith("https://")).toBe(true);
  });

  it("公開ページから、形に合うリンクと更新日を拾う。世代より前の更新分・更新日の読めないリンクは落とさない", () => {
    const ds = MASTERS_CONFIG.datasets.checkmaster;
    const html = [
      '<a href="index.files/20261030_CC_JIRE_CHECKMASTA.zip" class="x">チェックマスタ(ZIP:1KB)</a>',
      '<a href="index.files/20251031_CC_JIREI_CHECKMASTA.zip">チェックマスタ</a>',
      '<a href="index.files/20261030_CC_JIREI_HONBUTENKENJOUKEN.zip">本部点検条件</a>',
      '<a href="https://example.com/20261030_CC_JIREI_CHECKMASTA.zip">よそのリンク</a>',
    ].join("\n");
    expect(linksOf(html, ds.page, ds, "checkmaster")).toEqual([
      { dataset: "checkmaster", url: "https://www.hpdx.or.jp/shinryohoshu/hpdx_cc/index.files/20261030_CC_JIRE_CHECKMASTA.zip", snapshot: "20261030" },
      { dataset: "checkmaster", url: "https://www.hpdx.or.jp/shinryohoshu/hpdx_cc/index.files/20251031_CC_JIREI_CHECKMASTA.zip", snapshot: "20251031", skip: "世代 R8 より前の更新分" },
    ]);
    const t = MASTERS_CONFIG.datasets.tensuhyo;
    expect(linksOf('<a class="files" href="index.files/tensuhyo_02.zip" target="_blank">医科電子点数表テーブル【令和8年11月2日】（ZIP）</a>', t.page, t, "tensuhyo")).toEqual([
      { dataset: "tensuhyo", url: "https://www.hpdx.or.jp/seikyushiharai/tensuhyo/ikashika/index.files/tensuhyo_02.zip", snapshot: "20261102" },
    ]);
    expect(linksOf('<a href="index.files/tensuhyo_02.zip">医科電子点数表テーブル</a>', t.page, t, "tensuhyo")[0].skip).toBe("更新日を読み取れない");
  });

  it("zip の中の名前：パスの細工は断る。置くときの名前は、パスを捨てて英数字と少しの記号だけにする", () => {
    expect(safeName("../../etc/passwd")).toBeNull();
    expect(safeName("/abs/s_20261102.csv")).toBeNull();
    expect(safeName("a/../../b.csv")).toBeNull();
    expect(safeName("tensuhyo_02/")).toBe("");
    // Shift_JIS の名前のバイト列（2 バイトめが 0x5C のものがある）
    expect(safeName(`tensuhyo_02/01 ${String.fromCharCode(0x95, 0x5c, 0x83)}e.csv`)).toBe("01 ___e.csv");
    expect(safeName("s_20261102.csv")).toBe("s_20261102.csv");
  });

  // round-32 S-10：目次（unzip -l）の申告ではなく、unzip -p が実際に書き出す量を数える。unzip がない環境では飛ばす
  const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;
  if (!hasUnzip) process.stderr.write("fetch-masters：unzip がないので、展開の大きさのテストを 1 件飛ばした\n");
  it.skipIf(!hasUnzip)("展開：書き出した量が上限を超えたら止め、書きかけのファイルを消す。上限の内なら、書いたバイト数を返す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fetch-masters-"));
    try {
      // 1MB の 0 を deflate で入れた zip（圧縮後は 1KB ほど）
      const data = Buffer.alloc(1024 * 1024);
      const zip = path.join(dir, "a.zip");
      writeFileSync(zip, zipOf("s_20261102.csv", data));
      const ok = path.join(dir, "ok.out");
      expect(await extractCapped(zip, "s_20261102.csv", ok, 2 * 1024 * 1024)).toBe(data.length);
      expect(statSync(ok).size).toBe(data.length);
      const over = path.join(dir, "over.out");
      await expect(extractCapped(zip, "s_20261102.csv", over, 64 * 1024)).rejects.toThrow("上限を超える");
      expect(existsSync(over)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** ファイル 1 つを deflate で入れた zip（テスト用。ローカルヘッダ・中央ディレクトリ・終端の 3 つ） */
function zipOf(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data);
  const n = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + body.length, 16);
  return Buffer.concat([local, n, body, central, n, end]);
}
