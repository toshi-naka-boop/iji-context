// フィクスチャ コネクタ（spec FR-104・105）：いまの合成データ（UKE・症例・カルテ）を、境界の型で表せる
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES } from "../../scripts/gen-uke";
import { createFixtureConnector } from "../../src/connect/fixture";
import { evaluate } from "../../src/engine";
import { toClaimContext } from "../../src/uke/cases";
import { crosscheck, type Chart } from "../../src/uke/crosscheck";
import { loadCase } from "../engine/helpers";
import { claimId, day, month, YM } from "../helpers/period";

const root = path.join(__dirname, "..", "..");
const fixture = createFixtureConnector(root);
const patients = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "patients.json"), "utf8")).patients;

describe("請求の境界", () => {
  it("K1〜K7 が UkeFile の形で返り、toClaimContext に渡すと症例 JSON と同じ ClaimContext・同じ判定になる", async () => {
    const { files, unmapped } = await fixture.claims!.getClaims({ yearMonth: YM });
    expect(unmapped).toEqual([]);
    expect(files.map((f) => [f.payer, f.receipts.length])).toEqual([
      ["国保連", 6],
      ["支払基金", 1],
    ]);
    for (const k of CASES) {
      const want = loadCase(k);
      const file = files.find((f) => f.payer === want.payer)!;
      const got = toClaimContext(file, want.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
      // choices（導出の入力）は症例 JSON だけが持ち、UKE には載らない
      const { choices: _choices, ...fromUke } = want as typeof want & { choices?: unknown };
      // UKE から作った請求は、コメントを持つ（commentsKnown が真）
      expect(got).toEqual({ ...fromUke, comments: [], commentsKnown: true });
      expect(evaluate(got)).toEqual(evaluate(want));
    }
  });

  it("患者の id と診療年月で絞れる", async () => {
    const one = await fixture.claims!.getClaims({ yearMonth: YM, patientIds: ["K6"] });
    expect(one.files.map((f) => [f.payer, f.receipts.map((r) => r.claimId)])).toEqual([["支払基金", [claimId("K6")]]]);
    expect((await fixture.claims!.getClaims({ yearMonth: month(1) })).files).toEqual([]);
  });
});

describe("患者基本情報の境界", () => {
  it("氏名・性別・生年月日と、保険・公費の一覧が返る（負担割合は症例の事実から。有効期間は合成データにないので null）", async () => {
    const k3 = patients[claimId("K3")];
    expect(await fixture.patient!.getPatient("K3")).toEqual({
      patientId: "K3",
      name: "架空　三郎",
      sex: 1,
      birth: k3.birth,
      coverages: [
        { kind: "医保", payerNumber: k3.insurer.number, symbol: "", memberNo: "00000003", burdenRatio: loadCase("K3").facts.burdenRatio["value"], validFrom: null, validUntil: null },
        { kind: "公費", payerNumber: k3.kohi[0].payerNo, symbol: "", memberNo: k3.kohi[0].recipientNo, burdenRatio: null, validFrom: null, validUntil: null },
      ],
    });
    const k6 = patients[claimId("K6")];
    expect((await fixture.patient!.getPatient("K6")).coverages).toEqual([{ kind: "医保", payerNumber: k6.insurer.number, symbol: "架空", memberNo: "00000006", burdenRatio: loadCase("K6").facts.burdenRatio["value"], validFrom: null, validUntil: null }]);
    await expect(fixture.patient!.getPatient("K9")).rejects.toThrow("合成データにない患者");
    await expect(fixture.patient!.getPatient("../K1")).rejects.toThrow("患者の id");
  });
});

describe("カルテ記載の境界", () => {
  it("合成カルテの記録と処方がそのまま返り、いまの照合（病名と処方の不一致）に同じ結果で渡せる", async () => {
    for (const k of ["K1", "K2", "K3", "K4", "K5"]) {
      const want = JSON.parse(readFileSync(path.join(root, "fixtures", "charts", `${k}.json`), "utf8")) as Chart;
      const got = await fixture.chart!.getChart({ patientId: k, yearMonth: YM });
      expect([got.entries, got.prescriptions]).toEqual([want.entries.map(({ date, s, a, p }) => ({ date, s, a, p })), want.prescriptions]);
      const { files } = await fixture.claims!.getClaims({ yearMonth: YM, patientIds: [k] });
      const patient = files[0].receipts[0].patient;
      expect(got.diseases.map((d) => d.name)).toEqual(patient.diseases.map((d) => d.name));
      expect(crosscheck(patient, { claimId: want.claimId, entries: got.entries, prescriptions: got.prescriptions })).toEqual(crosscheck(patient, want));
    }
    // K4 は不一致が 1 件出る症例（照合が空振りしていないことの確かめ）
    const k4 = await fixture.chart!.getChart({ patientId: "K4", yearMonth: YM });
    expect(k4.prescriptions).toEqual([{ date: day(13), category: "DOAC" }]);
  });

  it("合成カルテのない患者（K6）・別の月は、空の記録で返る", async () => {
    expect((await fixture.chart!.getChart({ patientId: "K6", yearMonth: YM })).entries).toEqual([]);
    expect((await fixture.chart!.getChart({ patientId: "K1", yearMonth: month(-1) })).entries).toEqual([]);
  });
});
