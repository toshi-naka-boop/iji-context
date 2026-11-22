// 背反の組の院内の知識の、点検の画面の文と出し分け（app/local-pair.tsx・app/generic-findings.tsx が使う関数）
import { describe, expect, it } from "vitest";
import { pressText } from "../../src/messages";

describe("「条件に当たる」のボタンの文", () => {
  it("日ごとのボタンは日付と「条件に当たる」。1 日目から付くので「も」を付けない", () => {
    expect(pressText("2026-10-22")).toBe("10月22日：条件に当たる");
    expect(pressText("2026-10-03")).toBe("10月3日：条件に当たる");
  });
  it("同一月の表（日付なし）も「も」を付けない", () => {
    expect(pressText(null)).toBe("この請求は条件に当たる");
    expect(pressText(null)).not.toContain("も条件");
  });
});
