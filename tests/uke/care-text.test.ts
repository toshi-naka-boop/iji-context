// 聞き取りの画面の「今の申告」は、内部のキーを出さず画面の言葉で出す。施設は施設名（round-82）
import { describe, expect, it } from "vitest";
import { careValueText } from "../../src/care/text";
import { day, YM } from "../helpers/period";

const homes = [{ homeId: "H12345678", name: "架空の特養さくら" }];
describe("careValueText", () => {
  it("住まいの種別・短期入所・訪問看護の保険", () => {
    expect(careValueText("residenceType", { type: "特養（地域密着型を含む）", careHomeId: "H12345678" }, homes)).toBe("特養（地域密着型を含む）（入所先：架空の特養さくら）");
    expect(careValueText("shortStay", { status: "使っていない" }, homes)).toBe("使っていないと確かめた");
    const t = careValueText("shortStay", { status: "使った", uses: [{ kind: "短期入所生活介護", start: day(20), end: day(24), careHomeId: "H12345678", fromDischarge: "いいえ" }] }, homes);
    expect(t).toBe(`使った：短期入所生活介護（${Number(YM.slice(5))}/20〜${Number(YM.slice(5))}/24）・利用先：架空の特養さくら・退院日から：いいえ`);
    for (const key of ["type:", "status:", "careHomeId", "fromDischarge", "H12345678"]) expect(t).not.toContain(key);
    expect(careValueText("nurseInsurance", { value: "介護保険" }, homes)).toBe("介護保険");
  });
});
