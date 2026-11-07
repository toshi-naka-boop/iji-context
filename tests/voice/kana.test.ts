// 声で答えた名前をひらがなにする（2026-11-07）：直すのは漢字が混じるときだけ。モデルの答えはひらがなだけのときに使う
import { describe, expect, it } from "vitest";
import { acceptReading, needsKana, toHiragana } from "../../src/voice/kana";

describe("聞き取った名前のひらがな化", () => {
  it("漢字が混じるときだけ直す（ひらがな・カタカナ・英字はそのまま）", () => {
    expect(needsKana("敏之")).toBe(true);
    expect(needsKana("としゆき")).toBe(false);
    expect(needsKana("トシ")).toBe(false);
    expect(needsKana("Toshi")).toBe(false);
  });
  it("モデルの答えがひらがなと「ー」だけなら使い、そうでなければ聞き取ったまま", () => {
    expect(acceptReading({ reading: "としゆき" }, "敏之")).toBe("としゆき");
    expect(acceptReading({ reading: "ゆーき" }, "勇気")).toBe("ゆーき");
    expect(acceptReading({ reading: "トシユキ" }, "敏之")).toBe("敏之");
    expect(acceptReading({ reading: "としゆきさん、です" }, "敏之")).toBe("敏之");
    expect(acceptReading({ reading: "" }, "敏之")).toBe("敏之");
    expect(acceptReading(null, "敏之")).toBe("敏之");
  });
  it("漢字がなければモデルを呼ばずにそのまま返す", async () => {
    expect(await toHiragana("トシ")).toBe("トシ");
  });
});
