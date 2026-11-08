// 立ち絵の表情は場面で決める（正解＝喜び、愚痴・間違い＝落ち込み、ほかは通常）
import { describe, expect, it } from "vitest";
import { faceFor, faceImage } from "../../src/mentor/face";

describe("立ち絵の表情", () => {
  it("正解したときは喜び、間違えたときは落ち込み、ほかは通常", () => {
    expect(faceFor("正方向", "算定")).toBe("喜び");
    expect(faceFor("新人の誤り", "算定")).toBe("落ち込み");
    expect(faceFor("通常", "算定")).toBe("通常");
    expect(faceFor("カルテ不足", "雑談")).toBe("通常");
  });
  it("愚痴を聞くときは、場面にかかわらず落ち込み", () => {
    expect(faceFor("通常", "愚痴")).toBe("落ち込み");
    expect(faceFor("正方向", "愚痴")).toBe("落ち込み");
  });
  it("絵のファイル名", () => {
    expect(faceImage("suit", "喜び")).toBe("/characters/suit-joy.png");
  });
});
