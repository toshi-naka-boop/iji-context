// F4 の照合：病名と処方の不一致（K4）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateQuery } from "../../src/query/doctor-query";
import { crosscheck, type Chart } from "../../src/uke/crosscheck";
import type { UkePatient } from "../../src/uke/types";

const root = path.join(__dirname, "..", "..");
const chart = JSON.parse(readFileSync(path.join(root, "fixtures/charts/K4.json"), "utf8")) as Chart;
const patient = (JSON.parse(readFileSync(path.join(root, "fixtures/uke/patients.json"), "utf8")) as { patients: Record<string, UkePatient> }).patients["K4-2025-03"];

describe("病名と処方の不一致", () => {
  it("K4：DOAC を処方しているのに傷病名が「心房細動」だけ → 医師確認の下書きが 1 件。7 要件の検証を通る", () => {
    const m = crosscheck(patient, chart);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ ruleId: "M01", disease: "心房細動" });
    expect(m[0].draft.options).toEqual(["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"]);
    expect(m[0].draft.indicators.map((i) => i.text)).toContain("A: AF / P: DOAC 継続");
    expect(validateQuery(m[0].draft)).toEqual([]);
  });

  it("医師の回答と承認で「非弁膜症性心房細動」が確定すると、不一致は出なくなる", () => {
    expect(crosscheck(patient, chart, ["非弁膜症性心房細動"])).toEqual([]);
  });

  it("DOAC の処方がなければ出ない。心房細動の傷病名がなければ出ない", () => {
    expect(crosscheck(patient, { ...chart, prescriptions: [] })).toEqual([]);
    expect(crosscheck({ ...patient, diseases: [{ name: "高血圧症", start: "20240401", main: true }] }, chart)).toEqual([]);
  });
});
