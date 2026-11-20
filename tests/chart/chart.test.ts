// 訪問カルテ（FR-69）：AI が取り出した事実の検査と、その月の請求・照合用カルテへの重ね方
import { describe, expect, it } from "vitest";
import { validateFacts, type ChartNote } from "../../src/chart/extract";
import { chartWithNotes, eventsFromNotes, withNotes } from "../../src/chart/notes";
import type { ClaimContext } from "../../src/engine/types";
import k4 from "../../fixtures/cases/K4.json";
import { claimId, day } from "../helpers/period";

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
  it("不安・不眠の薬は、カルテに書かれた処方から取った「あり」「なし」だけを残す", () => {
    const r = validateFacts(
      {
        facts: [
          { kind: "不安・不眠の薬", value: "なし", quote: "エリキュース 5mg" },
          { kind: "不安・不眠の薬", value: "たぶんあり", quote: "エリキュース 5mg" },
          { kind: "不安・不眠の薬", value: "あり", quote: "架空の睡眠の薬" },
        ],
      },
      note,
    );
    expect(r.facts).toEqual([{ kind: "不安・不眠の薬", value: "なし", quote: "エリキュース 5mg" }]);
    expect(r.dropped.map((d) => d.why)).toEqual(["不安・不眠の薬は「あり」か「なし」で入れる", "カルテにない言葉から取っている"]);
  });
  it("形が違う出力は全部捨てる", () => {
    expect(validateFacts("x", note).facts).toEqual([]);
  });
});

describe("その月の請求に重ねる", () => {
  const K4 = k4 as unknown as ClaimContext;
  it("確かめた不安・不眠の薬は、その日の既存の処方の出来事に重ねる。処方の出来事は作らず、ほかの日には効かない", () => {
    const rx = (date: string, psychotropic: boolean | null) => ({ type: "prescription" as const, date, oralKinds: 3, days: 28, psychotropic });
    const psy = (date: string, value: string) => ({ date, kind: "訪問診療" as const, note, facts: [{ kind: "不安・不眠の薬" as const, value, quote: "エリキュース 5mg" }] });
    const of = (events: ClaimContext["events"], notes: Parameters<typeof eventsFromNotes>[2]) => eventsFromNotes(events, K4.facts, notes).events.filter((e) => e.type === "prescription");
    // 分からない（null）の日：「あり」で真、「なし」で偽。別の日の処方はそのまま
    expect(of([rx(day(13), null), rx(day(20), null)], [psy(day(13), "あり")])).toEqual([rx(day(13), true), rx(day(20), null)]);
    expect(of([rx(day(13), null), rx(day(20), null)], [psy(day(20), "なし")])).toEqual([rx(day(13), null), rx(day(20), false)]);
    // 記録が「あり」の日を「なし」で上書きしない。同じ日のカルテが食い違えば「あり」
    expect(of([rx(day(13), true)], [psy(day(13), "なし")])).toEqual([rx(day(13), true)]);
    expect(of([rx(day(13), false)], [psy(day(13), "なし"), psy(day(13), "あり")])).toEqual([rx(day(13), true)]);
    // その日に処方の出来事がなければ、何も足さない。読み取っていないカルテは、処方の出来事を変えない
    expect(of([], [psy(day(13), "あり")])).toEqual([]);
    expect(of([rx(day(13), null)], [{ date: day(13), kind: "訪問診療", note, facts: [] }])).toEqual([rx(day(13), null)]);
  });
  it("書いた訪問診療は訪問の出来事と行に足し、同じ日の訪問は重ねない", () => {
    const c = withNotes(K4, [
      { date: day(20), kind: "訪問診療", note, facts: [] },
      { date: day(13), kind: "訪問診療", note, facts: [] },
    ]);
    expect(c.lines.find((l) => l.kubun === "C001_1I")).toEqual({ kubun: "C001_1I", count: 3, dates: [day(13), day(20), day(27)] });
    expect(c.events.filter((e) => e.type === "visit").length).toBe(3);
  });
  it("往診は往診料の行になり、急性増悪の記載があれば月の急性増悪を「あり」にする", () => {
    const c = withNotes(K4, [{ date: day(15), kind: "往診", note, facts: [{ kind: "急性増悪", value: "あり", quote: "AF" }] }]);
    expect(c.lines.find((l) => l.kubun === "C000")?.dates).toEqual([day(15)]);
    expect(c.facts.acuteExacerbation).toEqual({ known: true, value: true });
  });
  it("照合用のカルテに、書いた記録と処方の分類を足す", () => {
    const ch = chartWithNotes(null, claimId("K4"), [{ date: day(20), kind: "訪問診療", note, facts: [{ kind: "処方", value: "DOAC", quote: "エリキュース 5mg" }] }]);
    expect(ch?.entries[0].a).toBe("AF");
    expect(ch?.prescriptions).toEqual([{ date: day(20), category: "DOAC" }]);
  });
});
