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
