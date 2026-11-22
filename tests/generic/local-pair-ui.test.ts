// 背反の組の院内の知識の、点検の画面の文と出し分け（app/local-pair.tsx・app/generic-findings.tsx が使う関数）
import { describe, expect, it } from "vitest";
import { returnsOutside } from "../../src/generic/local-pair";
import { pressText } from "../../src/messages";
import { C } from "./small-tensuhyo";

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

describe("返戻の入口をどこに出すか（returnsOutside）", () => {
  const r1 = { a: C.oushin, b: C.houmon, tani: 1, ids: ["local/x"] };
  const r2 = { a: C.houmon, b: C.sanso, tani: 2, ids: ["local/y"] };
  it("その組の G05 の指摘がある組はカードの中（外には出さない）。ない組だけ外に出す", () => {
    expect(returnsOutside([r1, r2], [{ a: r1.a, b: r1.b, tani: 1 }, undefined])).toEqual([r2]);
  });
  it("同じコードでも表（tani）が違えば別の組", () => {
    expect(returnsOutside([r1], [{ a: r1.a, b: r1.b, tani: 3 }])).toEqual([r1]);
  });
  it("指摘がなければ全部外", () => {
    expect(returnsOutside([r1, r2], [])).toEqual([r1, r2]);
  });
});
