// scripts/fetch-masters.ts の、通信しない部分（公開ページからリンクを拾う・zip の中の名前の検査・接続先の一覧）。実際に落とす動作は、テストでは行わない
import { describe, expect, it } from "vitest";
import { allowedHosts, linksOf, safeName } from "../../scripts/fetch-masters";
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
});
