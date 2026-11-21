// ORCA API 形式・FHIR JP Core 形式のコネクタと、模擬サーバーとの結合（spec FR-110〜112・114）
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectorOf, enabledConnectors } from "../../src/connect";
import { coverageCsvId, createFhirConnector, FHIR_WIRE, FhirCondition, FhirCoverage, FhirEncounter, FhirMedicationRequest, FhirPatient, toCoverage } from "../../src/connect/fhir";
import { createFixtureConnector } from "../../src/connect/fixture";
import { createOrcaConnector, OrcaPatientResponse } from "../../src/connect/orca";
import { evaluate } from "../../src/engine";
import { toClaimContext } from "../../src/uke/cases";
import { CONNECT_FILES, generate, MOCK_PATIENTS } from "../../scripts/gen-connect";
import { loadCase } from "../engine/helpers";
import { claimId, dateIn, day, month as monthFrom, YM } from "../helpers/period";
import { failure, pointAt, startMock, type Mock } from "./helpers";

const root = path.join(__dirname, "..", "..");
const json = (f: string) => JSON.parse(readFileSync(path.join(root, f), "utf8"));

let mock: Mock;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.close());
afterEach(() => vi.unstubAllEnvs());

const orca = createOrcaConnector();
const fhir = createFhirConnector();
const fixture = createFixtureConnector(root);

const nextMonth = monthFrom(1);
/** 合成データの患者（fixtures/uke/patients.json）。模擬サーバーのデータはここから作ってある */
const patientOf = (k: string) => json("fixtures/uke/patients.json").patients[claimId(k)];
/** 3 つのコネクタで同じになるはずの K3（負担割合は接続先によって取れる・取れないがある。公費の有効期間は模擬サーバーの仮置き） */
const k3 = (ratio: number | null) => {
  const p = patientOf("K3");
  return {
    patientId: "K3",
    name: p.name,
    sex: 1,
    birth: p.birth,
    coverages: [
      { kind: "医保", payerNumber: p.insurer.number, symbol: "", memberNo: p.insurer.no, burdenRatio: ratio, validFrom: null, validUntil: null },
      { kind: "公費", payerNumber: p.kohi[0].payerNo, symbol: "", memberNo: p.kohi[0].recipientNo, burdenRatio: null, validFrom: dateIn(-6, 1), validUntil: dateIn(5, 31) },
    ],
  };
};

describe("模擬サーバーの応答は、コネクタと同じ定義（スキーマ）に合う", () => {
  it("模擬データは、症例と同じ合成データから作り直したものと一致する（基準月の患者・訪問日）", () => {
    const out = generate();
    expect(readFileSync(path.join(root, CONNECT_FILES.orca), "utf8")).toBe(out.orca);
    expect(readFileSync(path.join(root, CONNECT_FILES.fhir), "utf8")).toBe(out.fhir);
    expect(Object.keys(MOCK_PATIENTS)).toEqual(["K1", "K2", "K3", "K4"]);
  });
  it("ORCA 形式", () => {
    const data = json("fixtures/connect/orca.json");
    expect(Object.keys(data.patients)).toEqual(["K1", "K2", "K3", "K4"]);
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
    const k1 = patientOf("K1");
    expect((await orca.patient!.getPatient("K1")).coverages).toEqual([{ kind: "医保", payerNumber: k1.insurer.number, symbol: "", memberNo: k1.insurer.no, burdenRatio: 0.1, validFrom: null, validUntil: null }]);
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

  it("患者の id は、通信の前に文字種を確かめる。カルテ記載は持たない", async () => {
    pointAt(mock);
    await expect(orca.patient!.getPatient("K1&class=99")).rejects.toThrow("患者の id");
    expect(orca.chart).toBeUndefined();
  });
});

describe("ORCA 形式のコネクタ（請求。診療行為の API は xml2 形式）", () => {
  const claims = (patientIds: string[], yearMonth = YM) => orca.claims!.getClaims({ yearMonth, patientIds });

  it("模擬サーバー → コネクタ → 請求の境界 → 点検で、症例と同じ行・同じ判定になり、合計が採用値と一致する（K2＝6,372、K1＝14,806）", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECTORS", "orca");
    const { files, unmapped } = await connectorOf("orca", root).claims!.getClaims({ yearMonth: YM, patientIds: ["K2", "K1"] });
    expect(unmapped).toEqual([]);
    expect(files.map((f) => [f.payer, f.receipts.map((r) => r.claimId)])).toEqual([["国保連", [claimId("K2"), claimId("K1")]]]);
    for (const [k, total] of [["K2", 6372], ["K1", 14806]] as const) {
      const want = loadCase(k);
      const got = toClaimContext(files[0], want.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
      expect(got.lines).toEqual(want.lines);
      // 診療行為の API にコメントは載らないので、「コメントを持たない」請求になる
      expect([got.comments, got.commentsKnown]).toEqual([[], false]);
      expect(evaluate(got)).toEqual(evaluate(want));
      expect(evaluate(got).total).toBe(total);
    }
    // 患者と保険は患者基本情報から引く。レセプト種別と傷病名は、診療行為の API に載っていないので空
    expect(files[0].receipts[0].patient).toEqual({ ...patientOf("K2"), receiptType: "", diseases: [] });
    // 合成データのない月は、レセプトなし
    expect((await claims(["K2"], nextMonth)).files).toEqual([]);
  });

  it("版のコードの表にないコードの行は、断らずに点検の対象外の単位として残し、unmapped にも並べる。ほかの行はそのまま点検し、請求は一部の点検になる（U-Y・FR-160）", async () => {
    pointAt(mock);
    const good = (await claims(["K2"])).files[0].receipts[0];
    pointAt(mock, "unknown-code");
    const { files, unmapped } = await claims(["K2"]);
    const r = files[0].receipts[0];
    // 表にない行は、模擬サーバーが 1 行目の算定日のままコードだけ差し替えたもの
    const dates = good.lines[0].dates;
    expect(r.lines).toEqual(good.lines);
    expect(r.others).toEqual([{ unit: expect.any(Number), codes: ["100000001"], points: null, count: dates.length, days: expect.any(Array) }]);
    expect(r.others![0].days.flatMap((n, i) => (n > 0 ? [`${YM}-${String(i + 1).padStart(2, "0")}`] : []))).toEqual(dates);
    expect(unmapped).toEqual([{ claimId: r.claimId, code: "100000001", dates }]);
    expect(toClaimContext(files[0], r.claimId, { facility: loadCase("K2").facility, facts: loadCase("K2").facts, events: [], recordsKnown: false }).partial).toBe(true);
  });

  it("壊れた XML、DOCTYPE・実体の宣言つきの XML、項目の欠けた応答は受け取らない", async () => {
    pointAt(mock, "xml-broken");
    const broken = await failure(() => claims(["K2"]));
    expect([broken.kind, broken.message]).toEqual(["format", expect.stringContaining("XML として読めない")]);
    pointAt(mock, "xml-doctype");
    const doctype = await failure(() => claims(["K2"]));
    expect([doctype.kind, doctype.message]).toEqual(["format", expect.stringContaining("DOCTYPE")]);
    pointAt(mock, "broken");
    const schema = await failure(() => claims(["K2"]));
    expect([schema.kind, schema.message]).toEqual(["format", expect.stringContaining("Perform_Calendar")]);
    pointAt(mock, "html");
    expect((await failure(() => claims(["K2"]))).kind).toBe("format");
  });

  it("上限を超える応答は、XML として読む前に断る", async () => {
    vi.stubEnv("RESEMEN_CONNECT_MAX_BYTES", "65536");
    pointAt(mock, "huge");
    expect((await failure(() => claims(["K2"]))).kind).toBe("too_large");
    pointAt(mock, "huge-chunked");
    expect((await failure(() => claims(["K2"]))).kind).toBe("too_large");
  });

  it("__proto__ という名前の要素がある応答は受け取らず、Object.prototype も汚れない", async () => {
    pointAt(mock, "xml-proto");
    const e = await failure(() => claims(["K2"]));
    expect([e.kind, e.message]).toEqual(["format", expect.stringContaining("XML として読めない")]);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("相手の失敗の結果は upstream、いない患者は not_found、認証失敗は auth。患者の指定と、診療年月に当たる版は、通信の前に確かめる", async () => {
    pointAt(mock, "api-error");
    const e = await failure(() => claims(["K2"]));
    expect([e.kind, e.message]).toEqual(["upstream", expect.stringContaining("Api_Result 89")]);
    pointAt(mock);
    expect((await failure(() => claims(["K9"]))).kind).toBe("not_found");
    vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", "wrong-password");
    expect((await failure(() => claims(["K2"]))).kind).toBe("auth");

    vi.unstubAllEnvs();
    await expect(orca.claims!.getClaims({ yearMonth: YM })).rejects.toThrow("患者の id を指定する");
    await expect(claims(["K2<x>"])).rejects.toThrow("患者の id");
    await expect(claims(["A".repeat(20)])).rejects.toThrow("請求 id にできない");
    // 接続先の設定がなくても版の検査で止まる（＝通信の前）
    const noRevision = await failure(() => claims(["K2"], monthFrom(-36)));
    expect([noRevision.kind, noRevision.message]).toEqual(["format", expect.stringContaining("版がない")]);
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
    const want = { kind: "医保", payerNumber: "138057", symbol: "12-34", memberNo: "5678", burdenRatio: null, validFrom: "2024-04-01", validUntil: null };
    expect(coverage([{ system: FHIR_WIRE.coverageCsvSystem, value: csv }])).toEqual(want);
    // コロン区切り（JP Core の例 "00012345:あいう:１８７:05"）は、記号・番号を券面のまま写す。記号と枝番がない形（"00012345::１８７:"）も読む。
    // 保険者番号は、こちらも 00 で始まる 8 桁を 6 桁に戻す（仕様の例の番号は 5 桁を 8 桁にしたもので、実在の桁数ではない）
    expect(coverage([{ system: FHIR_WIRE.coverageMemberSystem, value: "00012345:あいう:１８７:05" }])).toEqual({ ...want, payerNumber: "012345", symbol: "あいう", memberNo: "１８７" });
    expect(coverage([{ system: FHIR_WIRE.coverageMemberSystem, value: "01139999::１８７:" }])).toMatchObject({ payerNumber: "01139999", symbol: "", memberNo: "１８７" });
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
    expect((await fhir.patient!.getPatient("K3")).coverages.map((c) => c.kind)).toEqual(["医保"]);
  });

  it("Encounter・MedicationRequest・Condition が訪問日・処方・傷病名になり、合成カルテと同じ日付・同じ処方になる", async () => {
    pointAt(mock);
    const k4 = await fhir.chart!.getChart({ patientId: "K4", yearMonth: YM });
    expect(k4).toEqual({
      patientId: "K4",
      yearMonth: YM,
      entries: [
        { date: day(13), s: "", a: "", p: "" },
        { date: day(27), s: "", a: "", p: "" },
      ],
      prescriptions: [{ date: day(13), category: "DOAC" }],
      diseases: [{ name: "心房細動", start: "2024-04-01" }],
    });
    const same = await fixture.chart!.getChart({ patientId: "K4", yearMonth: YM });
    expect(k4.entries.map((e) => e.date)).toEqual(same.entries.map((e) => e.date));
    expect([k4.prescriptions, k4.diseases]).toEqual([same.prescriptions, same.diseases]);
    // 12 回の訪問（1 ページ 1 件）もたどれる。別の月は空
    expect((await fhir.chart!.getChart({ patientId: "K3", yearMonth: YM })).entries).toHaveLength(12);
    expect((await fhir.chart!.getChart({ patientId: "K3", yearMonth: nextMonth })).entries).toEqual([]);
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
      ["orca", true, true, false],
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
