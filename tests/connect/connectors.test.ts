// ORCA API 形式・FHIR JP Core 形式のコネクタと、模擬サーバーとの結合（spec FR-110〜112・114）
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UNMAPPED_CODE } from "../../fixtures/connect/mock-server";
import { connectorOf, enabledConnectors } from "../../src/connect";
import { createFhirConnector, FhirCondition, FhirCoverage, FhirEncounter, FhirMedicationRequest, FhirPatient } from "../../src/connect/fhir";
import { createFixtureConnector } from "../../src/connect/fixture";
import { createOrcaConnector, OrcaMedicalResponse, OrcaPatientResponse } from "../../src/connect/orca";
import { evaluate } from "../../src/engine";
import { toClaimContext } from "../../src/uke/cases";
import { loadCase } from "../engine/helpers";
import { failure, pointAt, startMock, type Mock } from "./helpers";

const root = path.join(__dirname, "..", "..");
const json = (f: string) => JSON.parse(readFileSync(path.join(root, f), "utf8"));
const site = { clinic: json("fixtures/uke/patients.json").clinic, prefecture: "東京都" };
const YM = "2025-03";

let mock: Mock;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.close());
afterEach(() => vi.unstubAllEnvs());

const orca = createOrcaConnector(site);
const fhir = createFhirConnector();
const fixture = createFixtureConnector(root);

describe("模擬サーバーの応答は、コネクタと同じ定義（スキーマ）に合う", () => {
  it("ORCA 形式", () => {
    const data = json("fixtures/connect/orca.json");
    expect(Object.keys(data.patients)).toEqual(["K1", "K3", "K4"]);
    for (const r of Object.values(data.patients)) expect(OrcaPatientResponse.safeParse(r).success).toBe(true);
    for (const r of Object.values(data.medical)) expect(OrcaMedicalResponse.safeParse(r).success).toBe(true);
  });
  it("FHIR 形式", () => {
    const schemas = { Patient: FhirPatient, Coverage: FhirCoverage, Encounter: FhirEncounter, MedicationRequest: FhirMedicationRequest, Condition: FhirCondition };
    const { resources } = json("fixtures/connect/fhir.json");
    expect(new Set(resources.map((r) => r.resourceType))).toEqual(new Set(Object.keys(schemas)));
    for (const r of resources) expect([r.id, schemas[r.resourceType].safeParse(r).success]).toEqual([r.id, true]);
  });
});

describe("ORCA 形式のコネクタ", () => {
  it("患者基本情報が境界の型で返り、合成データ（フィクスチャ コネクタ）と同じ人・同じ保険になる", async () => {
    pointAt(mock);
    const k3 = await orca.patient!.getPatient("K3");
    expect(k3).toEqual({
      patientId: "K3",
      name: "架空　三郎",
      sex: 1,
      birth: "1946-04-01",
      coverages: [
        { kind: "医療保険", number: "39139999", symbol: "", memberNo: "00000003", burdenRatio: null, validFrom: null, validUntil: null },
        { kind: "公費", number: "54139999", symbol: "", memberNo: "9999999", burdenRatio: null, validFrom: "2024-10-01", validUntil: "2025-09-30" },
      ],
    });
    const same = await fixture.patient!.getPatient("K3");
    const core = (p: typeof k3) => ({ ...p, coverages: p.coverages.map(({ kind, number, symbol, memberNo }) => ({ kind, number, symbol, memberNo })) });
    expect(core(k3)).toEqual(core(same));
  });

  it("請求が UkeFile の形で返り、toClaimContext に渡すと症例と同じ算定行・同じ判定になる", async () => {
    pointAt(mock);
    const { files, unmapped } = await orca.claims!.getClaims({ yearMonth: YM, patientIds: ["K1", "K3", "K4"] });
    expect(unmapped).toEqual([]);
    expect(files.map((f) => [f.payer, f.prefecture, f.billingMonth, f.receipts.map((r) => r.claimId)])).toEqual([["国保連", "東京都", "2025-04", ["K1-2025-03", "K3-2025-03", "K4-2025-03"]]]);
    for (const k of ["K1", "K3", "K4"]) {
      const want = loadCase(k);
      const got = toClaimContext(files[0], want.claimId, { facility: want.facility, facts: want.facts, events: want.events, history: want.history });
      expect(got.lines).toEqual(want.lines);
      expect(evaluate(got)).toEqual(evaluate(want));
    }
    expect(files[0].receipts[1].patient.kohi).toEqual([{ payerNo: "54139999", recipientNo: "9999999" }]);
  });

  it("対応のないコードは例外にせず unmapped に入り、算定行には入らない", async () => {
    pointAt(mock, "unmapped");
    const { files, unmapped } = await orca.claims!.getClaims({ yearMonth: YM, patientIds: ["K1"] });
    expect(unmapped).toEqual([{ claimId: "K1-2025-03", code: UNMAPPED_CODE, dates: ["2025-03-12"] }]);
    expect(files[0].receipts[0].lines).toEqual(loadCase("K1").lines);
  });

  it("対応表は設定で差し替えられる。対応先がこのアプリの区分にないコードも unmapped", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_CODEMAP", path.join(root, "tests", "connect", "codemap-partial.json"));
    const { files, unmapped } = await orca.claims!.getClaims({ yearMonth: YM, patientIds: ["K4"] });
    const want = loadCase("K4").lines;
    expect(files[0].receipts[0].lines).toEqual([want[0]]);
    expect(unmapped.map((u) => u.dates)).toEqual(want.slice(1).map((l) => l.dates));
    vi.stubEnv("RESEMEN_CONNECT_ORCA_CODEMAP", path.join(root, "no-such-file.json"));
    expect((await failure(() => orca.claims!.getClaims({ yearMonth: YM, patientIds: ["K4"] }))).kind).toBe("config");
  });

  it("壊れた応答は形式違い（どの項目かだけを出す）。相手の失敗の結果は upstream、認証失敗は auth", async () => {
    pointAt(mock, "broken");
    const p = await failure(() => orca.patient!.getPatient("K1"));
    expect([p.kind, p.message]).toEqual(["format", expect.stringContaining("WholeName")]);
    const c = await failure(() => orca.claims!.getClaims({ yearMonth: YM, patientIds: ["K1"] }));
    expect(c.kind).toBe("format");

    pointAt(mock, "api-error");
    expect((await failure(() => orca.patient!.getPatient("K1"))).kind).toBe("upstream");
    pointAt(mock);
    expect((await failure(() => orca.patient!.getPatient("K9"))).kind).toBe("upstream");

    vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", "wrong-password");
    expect((await failure(() => orca.patient!.getPatient("K1"))).kind).toBe("auth");
  });

  it("患者の id・診療年月は、通信の前に文字種を確かめる", async () => {
    pointAt(mock);
    await expect(orca.patient!.getPatient("K1&class=99")).rejects.toThrow("患者の id");
    await expect(orca.claims!.getClaims({ yearMonth: "2025-3", patientIds: ["K1"] })).rejects.toThrow("診療年月");
    await expect(orca.claims!.getClaims({ yearMonth: YM })).rejects.toThrow("患者の id の指定");
  });
});

describe("FHIR 形式のコネクタ", () => {
  it("Patient・Coverage が患者基本情報になる（ページ送りをたどる。医療保険と公費は identifier system で分ける）", async () => {
    pointAt(mock);
    expect(await fhir.patient!.getPatient("K3")).toEqual({
      patientId: "K3",
      name: "架空　三郎",
      sex: 1,
      birth: "1946-04-01",
      coverages: [
        { kind: "医療保険", number: "39139999", symbol: "", memberNo: "00000003", burdenRatio: null, validFrom: null, validUntil: null },
        { kind: "公費", number: "54139999", symbol: "", memberNo: "9999999", burdenRatio: null, validFrom: "2024-10-01", validUntil: "2025-09-30" },
      ],
    });
  });

  it("保険者番号の identifier system は設定で差し替える。合わない加入情報は写さない", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_FHIR_INSURER_SYSTEM", "urn:example:another-system");
    expect((await fhir.patient!.getPatient("K3")).coverages.map((c) => c.kind)).toEqual(["公費"]);
  });

  it("Encounter・MedicationRequest・Condition が訪問日・処方・傷病名になり、合成カルテと同じ日付・同じ処方になる", async () => {
    pointAt(mock);
    const k4 = await fhir.chart!.getChart({ patientId: "K4", yearMonth: YM });
    expect(k4).toEqual({
      patientId: "K4",
      yearMonth: YM,
      entries: [
        { date: "2025-03-11", s: "", a: "", p: "" },
        { date: "2025-03-25", s: "", a: "", p: "" },
      ],
      prescriptions: [{ date: "2025-03-11", category: "DOAC" }],
      diseases: [{ name: "心房細動", start: "2024-04-01" }],
    });
    const same = await fixture.chart!.getChart({ patientId: "K4", yearMonth: YM });
    expect(k4.entries.map((e) => e.date)).toEqual(same.entries.map((e) => e.date));
    expect([k4.prescriptions, k4.diseases]).toEqual([same.prescriptions, same.diseases]);
    // 12 回の訪問（1 ページ 1 件）もたどれる。別の月は空
    expect((await fhir.chart!.getChart({ patientId: "K3", yearMonth: YM })).entries).toHaveLength(12);
    expect((await fhir.chart!.getChart({ patientId: "K3", yearMonth: "2025-04" })).entries).toEqual([]);
  });

  it("next リンクが別のホスト・接続先の範囲の外を指していたら拒否する。自分を指し続ける next は上限で止める", async () => {
    pointAt(mock, "next-other-host");
    const other = await failure(() => fhir.patient!.getPatient("K3"));
    expect([other.kind, other.message]).toEqual(["not_allowed", expect.stringContaining("範囲の外")]);
    expect(other.message).not.toContain("other-host");
    pointAt(mock, "next-outside");
    expect((await failure(() => fhir.patient!.getPatient("K3"))).kind).toBe("not_allowed");
    pointAt(mock, "next-loop");
    expect((await failure(() => fhir.patient!.getPatient("K3"))).kind).toBe("too_large");
  });

  it("壊れた応答は形式違い。認証失敗は auth。いない患者は not_found。患者番号の system がなければ config", async () => {
    pointAt(mock, "broken");
    const e = await failure(() => fhir.patient!.getPatient("K3"));
    expect([e.kind, e.message]).toEqual(["format", expect.stringContaining("birthDate")]);
    pointAt(mock, "html");
    expect((await failure(() => fhir.chart!.getChart({ patientId: "K4", yearMonth: YM }))).kind).toBe("format");

    pointAt(mock);
    expect((await failure(() => fhir.patient!.getPatient("K9"))).kind).toBe("not_found");
    vi.stubEnv("RESEMEN_CONNECT_FHIR_TOKEN", "wrong-token");
    expect((await failure(() => fhir.patient!.getPatient("K3"))).kind).toBe("auth");
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM", "");
    expect((await failure(() => fhir.patient!.getPatient("K3"))).kind).toBe("config");
  });
});

describe("コネクタの登録", () => {
  it("既定はフィクスチャ コネクタだけ。外部のコネクタは RESEMEN_CONNECTORS に書いたときだけ", () => {
    vi.stubEnv("RESEMEN_CONNECTORS", "");
    expect(enabledConnectors(site, root).map((c) => c.id)).toEqual(["fixture"]);
    expect(() => connectorOf("orca", site, root)).toThrow("有効になっていない");
    vi.stubEnv("RESEMEN_CONNECTORS", "orca, FHIR");
    expect(enabledConnectors(site, root).map((c) => [c.id, !!c.patient, !!c.claims, !!c.chart])).toEqual([
      ["fixture", true, true, true],
      ["orca", true, true, false],
      ["fhir", true, false, true],
    ]);
    vi.stubEnv("RESEMEN_CONNECTORS", "orca,unknown");
    expect(() => enabledConnectors(site, root)).toThrow("知らないコネクタ");
  });

  it("有効にしただけ（接続先・許可リストなし）では、外へ出ない", async () => {
    vi.stubEnv("RESEMEN_CONNECTORS", "orca");
    expect((await failure(() => connectorOf("orca", site, root).patient!.getPatient("K1"))).kind).toBe("config");
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `http://127.0.0.1:${mock.port}/orca`);
    expect((await failure(() => connectorOf("orca", site, root).patient!.getPatient("K1"))).kind).toBe("not_allowed");
  });
});
