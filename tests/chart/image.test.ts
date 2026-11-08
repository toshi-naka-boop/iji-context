// 電子カルテの画面の画像から書き写す（2026-11-08）：受け付ける画像の決まりと、形の違う出力の扱い。モデルは呼ばない
import { describe, expect, it } from "vitest";
import { imageTypeOf, readChartImage, toFreeText, toImageText, MAX_IMAGE_BYTES } from "../../src/chart/image";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);

describe("受け付ける画像", () => {
  it("PNG・JPEG・WebP を先頭のバイト列で見分ける", () => {
    expect(imageTypeOf(png)).toBe("image/png");
    expect(imageTypeOf(jpeg)).toBe("image/jpeg");
    expect(imageTypeOf(webp)).toBe("image/webp");
  });
  it("それ以外（PDF・文字・空）は受け付けない", () => {
    expect(imageTypeOf(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(imageTypeOf(Buffer.from("hello"))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(0))).toBeNull();
  });
  it("空・5MB 超え・画像でないものは、モデルを呼ぶ前に断る", async () => {
    await expect(readChartImage(Buffer.alloc(0))).rejects.toThrow("5MB");
    await expect(readChartImage(Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]))).rejects.toThrow("5MB");
    await expect(readChartImage(Buffer.from("%PDF-1.7"))).rejects.toThrow("PNG");
  });
});

describe("書き写した結果", () => {
  it("形の違う出力は空の欄にする", () => {
    expect(toImageText(null)).toEqual({ diseases: "", record: "", rx: "", unreadable: false });
    expect(toImageText({ diseases: 1, record: " 変わりなし。 ", rx: null, unreadable: "true" })).toEqual({ diseases: "", record: "変わりなし。", rx: "", unreadable: false });
  });
  it("診療記録・病名・処方の順に 1 つの文にし、空の欄は入れない", () => {
    expect(toFreeText({ record: "変わりなし。\n非弁膜症性心房細動。", diseases: "（主）心房細動", rx: "DOAC", unreadable: false })).toBe("変わりなし。\n非弁膜症性心房細動。\n病名：（主）心房細動\n処方：DOAC");
    expect(toFreeText({ record: "変わりなし。", diseases: "", rx: "", unreadable: false })).toBe("変わりなし。");
  });
});
