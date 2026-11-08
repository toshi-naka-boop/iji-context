// 自由記述を SOAP に整える（2026-11-07）：AI が足した言い回しを決まった規則で見つける。見本は 5 人分
import { describe, expect, it } from "vitest";
import { unmatchedPhrases } from "../../src/chart/soap";
import SAMPLES from "../../fixtures/charts/samples.json";

const note = (n: Partial<Record<"s" | "o" | "a" | "p" | "rx", string>>) => ({ s: "", o: "", a: "", p: "", rx: "", ...n });

describe("SOAP に整えた結果の検査", () => {
  it("原文の言葉を振り分けただけなら、知らせるものはない（句読点・空白の違いは見ない）", () => {
    expect(unmatchedPhrases(note({ s: "変わりなし", a: "非弁膜症性心房細動", rx: "DOAC継続" }), "変わりなし。非弁膜症性心房細動。DOAC 継続。")).toEqual([]);
  });
  it("原文にない言い回し（病名の言い換え・足した薬）を返す", () => {
    expect(unmatchedPhrases(note({ a: "心房細動（非弁膜症性）", rx: "DOAC継続、利尿薬" }), "AF。DOAC継続。")).toEqual(["心房細動（非弁膜症性）", "利尿薬"]);
  });
});

describe("カルテ記載の見本", () => {
  it("5 人全員に、足りないカルテとちゃんとしたカルテがある", () => {
    for (const k of ["K1", "K2", "K3", "K4", "K5"]) {
      const s = (SAMPLES as Record<string, unknown>)[`${k}-2025-03`] as { lacking: string; complete: string };
      expect(s.lacking && s.complete && s.lacking !== s.complete).toBeTruthy();
    }
  });
  it("K3 と K4 の足りないカルテは EM 5-1 の例（「PD」だけ・「AF」だけ）", () => {
    expect(SAMPLES["K3-2025-03"].lacking).toContain("PD");
    expect(SAMPLES["K4-2025-03"].lacking).toContain("AF");
    expect(SAMPLES["K4-2025-03"].complete).toContain("非弁膜症性");
  });
});
