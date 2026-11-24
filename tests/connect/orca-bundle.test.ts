// ORCA で受け取った包括の検査の群が下限に届かないとき（design.md §19-13 の 2）：受け取り全体を断らず、点検の対象外の単位として残す（UKE の取り込みと同じ）
import { describe, expect, it } from "vitest";
import { ORCA_WIRE, toLines } from "../../src/connect/orca";
import { resolveRevision } from "../../src/engine/revisions";
import { YM } from "../helpers/period";

const rev = resolveRevision(YM);
const cal = (day: number) => Array.from({ length: 31 }, (_, d) => (d === day - 1 ? "1" : "0")).join("");
const response = (codes: string[], day = 10) => ({
  [ORCA_WIRE.xmlRoot]: { [ORCA_WIRE.medicalRoot]: { Api_Result: "00", Patient_Information: { Patient_ID: "K1" }, Perform_Date: YM, Medical_List_Information: { Medical_List_Information_child: codes.map((c) => ({ Medication_Code: c, Perform_Total_Number: "1", Perform_Calendar: cal(day) })) } } },
});

describe("ORCA の包括の検査（v44。§19-13 の 2）", () => {
  it("D007・D013 の群が下限に届かない単位は、断らずに対象外の単位として残す。ほかの行はそのまま", () => {
    const houmon = rev.codes.C001_1I.primary;
    for (const b of rev.bundles) {
      const short = b.members.slice(0, b.tiers[0].min - 1);
      const r = toLines("K1", YM, response([houmon, ...short]));
      expect(r.lines.map((l) => l.kubun)).toEqual(["C001_1I"]);
      expect(r.others).toEqual([{ unit: 1, codes: short, points: null, count: 1, days: Array.from({ length: 31 }, (_, d) => (d === 9 ? 1 : 0)) }]);
    }
  });

  it("下限に届く群は、今までどおり項目数で区分を引く", () => {
    for (const b of rev.bundles) {
      const r = toLines("K1", YM, response(b.members.slice(0, b.tiers[0].min)));
      expect(r.lines.map((l) => l.kubun)).toEqual([b.tiers[0].kubun]);
      expect(r.others).toEqual([]);
    }
  });
});

describe("BNP（codes と D008 の群の両方。EM §2-8 DUP-01。§19-13 の 1）：群を先に数える", () => {
  const BNP = "160162350";
  const FT4 = "160033310";
  const CORTISOL = "160034010";
  it("ORCA：BNP だけは D008_19、BNP と D008 の項目で 3 つ以上なら D008_3、BNP と 1 項目なら BNP は D008_19 で、ほかは対象外の単位", () => {
    expect(toLines("K1", YM, response([BNP])).lines.map((l) => l.kubun)).toEqual(["D008_19"]);
    expect(toLines("K1", YM, response([BNP, FT4, CORTISOL])).lines.map((l) => l.kubun)).toEqual(["D008_3"]);
    const two = toLines("K1", YM, response([BNP, FT4]));
    expect(two.lines.map((l) => l.kubun)).toEqual(["D008_19"]);
    expect(two.others.map((o) => o.codes)).toEqual([[FT4]]);
  });

  it("UKE の取り込み：BNP だけの単位は D008_19、BNP と D008 の項目で 3 つの単位は D008_3", async () => {
    const { mapClaim } = await import("../../src/uke/uke");
    const unit = (codes: string[], points: number, line: number) => ({ line, items: codes.map((code, i) => ({ kind: "SI" as const, code, line: line + i, quantity: "", shikibetsu: i === 0 ? "60" : "", unitPrice: "" })), points, count: 1, days: Array.from({ length: 31 }, (_, d) => (d === 9 ? 1 : 0)), futan: "", shikibetsu: "60" });
    const claim = { yearMonth: YM, units: [unit([BNP], rev.points.D008_19.points!, 10), unit([BNP, FT4, CORTISOL], rev.points.D008_3.points!, 20)], comments: [] } as unknown as Parameters<typeof mapClaim>[0];
    const m = mapClaim(claim, rev);
    expect(m.lines.map((l) => l.kubun)).toEqual(["D008_19", "D008_3"]);
    expect(m.others).toEqual([]);
  });
});
