// ORCA API 形式・FHIR JP Core 形式のコネクタと、模擬サーバーとの結合（spec FR-110〜112・114）
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectorOf, enabledConnectors } from "../../src/connect";
import { coverageCsvId, createFhirConnector, FHIR_WIRE, FhirCondition, FhirCoverage, FhirEncounter, FhirMedicationRequest, FhirPatient, toCoverage } from "../../src/connect/fhir";
import { createFixtureConnector } from "../../src/connect/fixture";
import { createOrcaConnector, medicalMonthToLines, OrcaPatientResponse } from "../../src/connect/orca";
import { fictionalCode } from "../../src/engine/codes-fictional";
import { loadCase } from "../engine/helpers";
import { failure, pointAt, startMock, type Mock } from "./helpers";

const root = path.join(__dirname, "..", "..");
const json = (f: string) => JSON.parse(readFileSync(path.join(root, f), "utf8"));
const YM = "2025-03";

let mock: Mock;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.close());
afterEach(() => vi.unstubAllEnvs());

const orca = createOrcaConnector();
const fhir = createFhirConnector();
const fixture = createFixtureConnector(root);

/** 3 つのコネクタで同じになるはずの K3（負担割合は接続先によって取れる・取れないがある） */
const k3 = (ratio: number | null) => ({
  patientId: "K3",
  name: "架空　三郎",
  sex: 1,
  birth: "1946-04-01",
  coverages: [
    { kind: "医療保険", number: "39139999", symbol: "", memberNo: "00000003", burdenRatio: ratio, validFrom: null, validUntil: null },
    { kind: "公費", number: "54139999", symbol: "", memberNo: "9999999", burdenRatio: null, validFrom: "2024-10-01", validUntil: "2025-09-30" },
  ],
});

describe("模擬サーバーの応答は、コネクタと同じ定義（スキーマ）に合う", () => {
  it("ORCA 形式", () => {
    const data = json("fixtures/connect/orca.json");
    expect(Object.keys(data.patients)).toEqual(["K1", "K3", "K4"]);
    for (const r of Object.values(data.patients)) expect(OrcaPatientResponse.safeParse(r).success).toBe(true);
  });
  it("FHIR 形式", () => {
    const schemas = { Patient: FhirPatient, Coverage: FhirCoverage, Encounter: FhirEncounter, MedicationRequest: FhirMedicationRequest, Condition: FhirCondition };
    const { resources } = json("fixtures/connect/fhir.json");
    expect(new Set(resources.map((r) => r.resourceType))).toEqual(new Set(Object.keys(schemas)));
    for (const r of resources) expect([r.id, schemas[r.resourceType].safeParse(r).success]).toEqual([r.id, true]);
  });
});

describe("ORCA 形式のコネクタ（患者基本情報）", () => {
  it("患者基本情報が境界の型で返り、合成データ（フィクスチャ コネクタ）と同じ人・同じ保険・同じ負担割合になる", async () => {
    pointAt(mock);
    const got = await orca.patient!.getPatient("K3");
    // 負担割合は、公費の付かない保険組合せの外来負担割合
    expect(got).toEqual(k3(0.1));
    const same = await fixture.patient!.getPatient("K3");
    const core = (p: typeof got) => ({ ...p, coverages: p.coverages.map(({ validFrom, validUntil, ...c }) => c) });
    expect(core(got)).toEqual(core(same));
    expect((await orca.patient!.getPatient("K1")).coverages).toEqual([{ kind: "医療保険", number: "39139999", symbol: "", memberNo: "00000001", burdenRatio: 0.1, validFrom: null, validUntil: null }]);
  });

  it("壊れた応答は形式違い（どの項目かだけを出す）。相手の失敗の結果は upstream、いない患者は not_found、認証失敗は auth", async () => {
    pointAt(mock, "broken");
    const p = await failure(() => orca.patient!.getPatient("K1"));
    expect([p.kind, p.message]).toEqual(["format", expect.stringContaining("WholeName")]);

    pointAt(mock, "api-error");
    const e = await failure(() => orca.patient!.getPatient("K1"));
    expect([e.kind, e.message]).toEqual(["upstream", expect.stringContaining("Api_Result 89")]);
    pointAt(mock);
    expect((await failure(() => orca.patient!.getPatient("K9"))).kind).toBe("not_found");

    vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", "wrong-password");
    expect((await failure(() => orca.patient!.getPatient("K1"))).kind).toBe("auth");
  });

  it("患者の id は、通信の前に文字種を確かめる。請求（診療行為）は xml2 形式だけなので持たない", async () => {
    pointAt(mock);
    await expect(orca.patient!.getPatient("K1&class=99")).rejects.toThrow("患者の id");
    expect([orca.claims, orca.chart]).toEqual([undefined, undefined]);
  });
});

describe("診療月診療コード情報 → 算定行（通信なし。公式仕様の項目名）", () => {
  /** 算定した日に 1 を並べた 31 文字 */
  const calendar = (dates: string[]) => Array.from({ length: 31 }, (_, i) => (dates.some((d) => Number(d.slice(8)) === i + 1) ? "1" : "0")).join("");
  const month = (k: string, extra: { Medication_Code: string; Perform_Calendar: string }[] = []) => ({
    Perform_Date: YM,
    Medical_List_Information: [...loadCase(k).lines.map((l) => ({ Medication_Code: fictionalCode(l.kubun), Perform_Calendar: calendar(l.dates) })), ...extra],
  });
  const query = (k: string) => ({ claimId: `${k}-${YM}`, yearMonth: YM });

  it("算定日区分（Perform_Calendar）から日付を作り、症例と同じ算定行になる", () => {
    for (const k of ["K1", "K3", "K4"]) expect(medicalMonthToLines(month(k), query(k))).toEqual({ lines: loadCase(k).lines, unmapped: [] });
  });

  it("対応のないコードは例外にせず unmapped に入り、算定行には入らない", () => {
    const got = medicalMonthToLines(month("K1", [{ Medication_Code: "000000000", Perform_Calendar: calendar(["2025-03-12"]) }]), query("K1"));
    expect(got.unmapped).toEqual([{ claimId: "K1-2025-03", code: "000000000", dates: ["2025-03-12"] }]);
    expect(got.lines).toEqual(loadCase("K1").lines);
  });

  it("対応表は設定で差し替えられる。対応先がこのアプリの区分にないコードも unmapped", async () => {
    vi.stubEnv("RESEMEN_CONNECT_ORCA_CODEMAP", path.join(root, "tests", "connect", "codemap-partial.json"));
    const want = loadCase("K4").lines;
    const got = medicalMonthToLines(month("K4"), query("K4"));
    expect(got.lines).toEqual([want[0]]);
    expect(got.unmapped.map((u) => u.dates)).toEqual(want.slice(1).map((l) => l.dates));
    vi.stubEnv("RESEMEN_CONNECT_ORCA_CODEMAP", path.join(root, "no-such-file.json"));
    expect((await failure(async () => medicalMonthToLines(month("K4"), query("K4")))).kind).toBe("config");
  });

  it("形の違う応答・頼んだ月と違う応答は形式違い", async () => {
    const bad = { Perform_Date: YM, Medical_List_Information: [{ Medication_Code: "x", Perform_Calendar: "1" }] };
    expect((await failure(async () => medicalMonthToLines(bad, query("K1")))).kind).toBe("format");
    expect((await failure(async () => medicalMonthToLines({ ...month("K1"), Perform_Date: "2025-04" }, query("K1")))).kind).toBe("format");
  });
});

describe("FHIR 形式のコネクタ", () => {
  it("Patient・Coverage が患者基本情報になる（ページ送りをたどる。氏名は漢字の表記を採る。医療保険は被保険者識別子から読む）", async () => {
    pointAt(mock);
    expect(await fhir.patient!.getPatient("K3")).toEqual(k3(null));
  });

  it("被保険者識別子は 2 つの形を読む。8 桁に足したゼロは外し、CSV 形式の全角は半角に戻す。記号・番号の拡張があればそちらを採る", () => {
    const csv = coverageCsvId("138057", "12-34", "5678", "01");
    // JP Core の例（"00012345","１２－３４","５６７８","00"）と同じ書き方。国保の 6 桁は先頭にゼロを足して 8 桁
    expect(csv).toBe('"00138057","１２－３４","５６７８","01"');
    const coverage = (identifier: { system: string; value: string }[], extension: unknown[] = []) =>
      toCoverage(FhirCoverage.parse({ resourceType: "Coverage", payor: [{}], identifier, extension, period: { start: "2024-04-01" } }));
    const want = { kind: "医療保険", number: "138057", symbol: "12-34", memberNo: "5678", burdenRatio: null, validFrom: "2024-04-01", validUntil: null };
    expect(coverage([{ system: FHIR_WIRE.coverageCsvSystem, value: csv }])).toEqual(want);
    // コロン区切り（JP Core の例 "00012345:あいう:１８７:05"）は、記号・番号を券面のまま写す。記号と枝番がない形（"00012345::１８７:"）も読む。
    // 保険者番号は、こちらも 00 で始まる 8 桁を 6 桁に戻す（仕様の例の番号は 5 桁を 8 桁にしたもので、実在の桁数ではない）
    expect(coverage([{ system: FHIR_WIRE.coverageMemberSystem, value: "00012345:あいう:１８７:05" }])).toEqual({ ...want, number: "012345", symbol: "あいう", memberNo: "１８７" });
    expect(coverage([{ system: FHIR_WIRE.coverageMemberSystem, value: "01139999::１８７:" }])).toMatchObject({ number: "01139999", symbol: "", memberNo: "１８７" });
    expect(
      coverage(
        [{ system: FHIR_WIRE.coverageCsvSystem, value: csv }],
        [
          { url: FHIR_WIRE.symbolExtension, valueString: "券面の記号" },
          { url: FHIR_WIRE.numberExtension, valueString: "券面の番号" },
        ],
      ),
    ).toEqual({ ...want, symbol: "券面の記号", memberNo: "券面の番号" });
    // 読めない識別子・知らない system は、医療保険として写さない
    expect(coverage([{ system: FHIR_WIRE.coverageCsvSystem, value: "こわれた値" }])).toBeNull();
    expect(coverage([{ system: "urn:example:unknown", value: csv }])).toBeNull();
  });

  it("公費負担者番号の identifier system は設定で差し替える（未確認のため）。合わない加入情報は写さない", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_FHIR_KOHI_SYSTEM", "urn:example:another-system");
    expect((await fhir.patient!.getPatient("K3")).coverages.map((c) => c.kind)).toEqual(["医療保険"]);
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
    expect(enabledConnectors(root).map((c) => c.id)).toEqual(["fixture"]);
    expect(() => connectorOf("orca", root)).toThrow("有効になっていない");
    vi.stubEnv("RESEMEN_CONNECTORS", "orca, FHIR");
    expect(enabledConnectors(root).map((c) => [c.id, !!c.patient, !!c.claims, !!c.chart])).toEqual([
      ["fixture", true, true, true],
      ["orca", true, false, false],
      ["fhir", true, false, true],
    ]);
    vi.stubEnv("RESEMEN_CONNECTORS", "orca,unknown");
    expect(() => enabledConnectors(root)).toThrow("知らないコネクタ");
  });

  it("有効にしただけ（接続先・許可リストなし）では、外へ出ない", async () => {
    vi.stubEnv("RESEMEN_CONNECTORS", "orca");
    expect((await failure(() => connectorOf("orca", root).patient!.getPatient("K1"))).kind).toBe("config");
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `http://127.0.0.1:${mock.port}/orca`);
    expect((await failure(() => connectorOf("orca", root).patient!.getPatient("K1"))).kind).toBe("not_allowed");
  });
});
