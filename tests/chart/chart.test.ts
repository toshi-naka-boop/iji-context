// 訪問カルテ（FR-69）：AI が取り出した事実の検査と、その月の請求・照合用カルテへの重ね方
import { describe, expect, it } from "vitest";
import { validateFacts, type ChartNote } from "../../src/chart/extract";
import { chartWithNotes, withNotes } from "../../src/chart/notes";
import type { ClaimContext } from "../../src/engine/types";
import k4 from "../../fixtures/cases/K4.json";

const note: ChartNote = { s: "動悸なし", o: "脈不整", a: "AF", p: "エリキュース継続", rx: "エリキュース 5mg" };

describe("取り出した事実の検査", () => {
  it("カルテに書かれた言葉から取った事実だけを残し、ない言葉から取ったものは捨てる", () => {
    const r = validateFacts(
      {
        facts: [
          { kind: "処方", value: "DOAC", quote: "エリキュース 5mg" },
          { kind: "病名の記載", value: "AF", quote: "AF" },
          { kind: "病名の記載", value: "非弁膜症性心房細動", quote: "非弁膜症性心房細動" },
          { kind: "検査", value: "BNP", quote: "BNP" },
        ],
      },
      note,
    );
    expect(r.facts.map((f) => f.value)).toEqual(["DOAC", "AF"]);
    expect(r.dropped.map((d) => d.why)).toEqual(["カルテにない言葉から取っている", "取り出す種類の外"]);
  });
  it("形が違う出力は全部捨てる", () => {
    expect(validateFacts("x", note).facts).toEqual([]);
  });
});

describe("その月の請求に重ねる", () => {
  const K4 = k4 as unknown as ClaimContext;
  it("書いた訪問診療は訪問の出来事と行に足し、同じ日の訪問は重ねない", () => {
    const c = withNotes(K4, [
      { date: "2025-03-18", kind: "訪問診療", note, facts: [] },
      { date: "2025-03-11", kind: "訪問診療", note, facts: [] },
    ]);
    expect(c.lines.find((l) => l.kubun === "C001_1I")).toEqual({ kubun: "C001_1I", count: 3, dates: ["2025-03-11", "2025-03-18", "2025-03-25"] });
    expect(c.events.filter((e) => e.type === "visit").length).toBe(3);
  });
  it("往診は往診料の行になり、急性増悪の記載があれば月の急性増悪を「あり」にする", () => {
    const c = withNotes(K4, [{ date: "2025-03-13", kind: "往診", note, facts: [{ kind: "急性増悪", value: "あり", quote: "AF" }] }]);
    expect(c.lines.find((l) => l.kubun === "C000")?.dates).toEqual(["2025-03-13"]);
    expect(c.facts.acuteExacerbation).toEqual({ known: true, value: true });
  });
  it("照合用のカルテに、書いた記録と処方の分類を足す", () => {
    const ch = chartWithNotes(null, "K4-2025-03", [{ date: "2025-03-18", kind: "訪問診療", note, facts: [{ kind: "処方", value: "DOAC", quote: "エリキュース 5mg" }] }]);
    expect(ch?.entries[0].a).toBe("AF");
    expect(ch?.prescriptions).toEqual([{ date: "2025-03-18", category: "DOAC" }]);
  });
});
