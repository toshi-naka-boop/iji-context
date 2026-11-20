// 以前の作り物の診療行為コード（99 で始まる 9 桁）が残っていないかの検査（design.md §11-8 完了条件 2。`npm run check:codes` と同じ検査をテストでも回す）
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { decode, hitsOf, isTarget, scan, trackedFiles } from "../../scripts/check-no-fictional-codes";

describe("check:codes", () => {
  it("同梱の UKE（Shift_JIS から読む）・連携の模擬応答・src・scripts・fixtures に、作り物のコードが残っていない", () => {
    const files = trackedFiles();
    // 見るべきものが対象に入っている
    for (const f of ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE", "fixtures/connect/orca.json", "fixtures/connect/mock-server.ts", "src/uke/uke.ts", "scripts/gen-uke.ts"]) expect(files, f).toContain(f);
    expect(scan(files)).toEqual([]);
  });

  it("9 桁ちょうどで 99 から始まる数字の並びだけを当てる（もっと長い番号の一部・ほかの頭の番号は当てない）", () => {
    expect(hitsOf("x.ts", 'const a = "990000001";\nconst b = "SI,14,1,990000030,,103,1";')).toEqual([
      { file: "x.ts", line: 1, text: "990000001" },
      { file: "x.ts", line: 2, text: "990000030" },
    ]);
    expect(hitsOf("x.ts", '"114000110" "9999999" "99999999" "9900000011" "urn:oid:1.2.392.100495.20.3.51.19999999999" "199000000"')).toEqual([]);
  });

  it("UKE は Shift_JIS として読んでから探す（日本語の行の中のコードも見つかる）", () => {
    const bytes = Buffer.concat([iconv.encode("RE,1,1318,202610,架空　一郎\r\nSI,14,1,990000001,,890,2\r\n", "Shift_JIS"), Buffer.from([0x1a])]);
    expect(hitsOf("a.UKE", decode("a.UKE", bytes))).toEqual([{ file: "a.UKE", line: 2, text: "990000001" }]);
  });

  it("対象は src・scripts・fixtures の下の、文字のファイルと UKE", () => {
    expect(["src/a.ts", "scripts/b.ts", "fixtures/connect/orca.json", "fixtures/uke/x.UKE", "fixtures/notices/n.html"].map(isTarget)).toEqual([true, true, true, true, true]);
    expect(["tests/a.ts", "app/page.tsx", "fixtures/notices/n.pdf", "README.md"].map(isTarget)).toEqual([false, false, false, false]);
  });
});
