// HL7 FHIR（JP Core）形式の読み取りコネクタ（spec FR-110）。検索（searchset の Bundle）を読むだけで、書き込みはしない。
// 相手は同梱の模擬サーバー（fixtures/connect/mock-server.ts）。実機にはつないでいない
import { z } from "zod";
import { connectJson, ConnectError, connectorEnv, formatError } from "./fetch";
import { assertQuery, monthRange, type Connector, type ConnectorChart, type ConnectorCoverage, type ConnectorPatient } from "./types";

export const FHIR_ID = "fhir";

// ───────────────────────────────────────────────────────────────────────────
// 通信の形（このコネクタと模擬サーバーが、同じこの定義を使う）
//
// 【確認済み】EM §2-6 F-1〜F-4（JP Core V1.2.0、FHIR 4.0.1。確認日 2026-11-17）
//   - プロファイルの canonical（JP_Patient・JP_Coverage・JP_Encounter・JP_MedicationRequest・JP_Condition）
//   - 患者番号の検索：Patient?identifier=urn:oid:1.2.392.100495.20.3.51.1[医療機関コード10桁]|患者番号
//     → system の全体を RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM に書く（医療機関ごとに違うので既定値を持たない）
//   - JP_Coverage の記号・番号の拡張の URL
//
// 【公式仕様で未確認。実機につなぐ前に確認する】
//   - 保険者番号・公費負担者番号の identifier system（EM F-5）。下の既定値は置き場所を示すだけの仮の値で、
//     RESEMEN_CONNECT_FHIR_INSURER_SYSTEM／RESEMEN_CONNECT_FHIR_KOHI_SYSTEM で差し替える。
//     番号を Coverage.payor[].identifier から読むこと、医療保険と公費をこの system で見分けることも未確認
//   - 記号・番号の拡張の値の型（valueString と仮定）、公費の受給者番号の置き場所（Coverage.subscriberId と仮定）
//   - 検索パラメータ（FHIR R4 の標準の名前を仮定：Coverage?beneficiary、Encounter?patient&date、
//     MedicationRequest?patient&authoredon、Condition?patient）を相手のサーバーが受けるか
//   - 氏名の読み方（name[].text、なければ family＋given。JP Core の漢字・カナの区別は見ていない）
//   - 訪問診療の Encounter の見分け方（class を見ていない。期間内の Encounter をすべて訪問日として返す）
//   - 負担割合の置き場所（未確認のため写していない）
// ───────────────────────────────────────────────────────────────────────────
export const FHIR_WIRE = {
  profiles: {
    Patient: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Patient",
    Coverage: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Coverage",
    Encounter: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Encounter",
    MedicationRequest: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_MedicationRequest",
    Condition: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Condition",
  },
  symbolExtension: "http://jpfhir.jp/fhir/core/Extension/StructureDefinition/JP_Coverage_InsuredPersonSymbol",
  numberExtension: "http://jpfhir.jp/fhir/core/Extension/StructureDefinition/JP_Coverage_InsuredPersonNumber",
  // ここから下は未確認
  defaultInsurerSystem: "urn:example:resemen:unconfirmed:insurer-number",
  defaultKohiSystem: "urn:example:resemen:unconfirmed:kohi-payer-number",
  search: {
    coveragePatient: "beneficiary",
    encounterPatient: "patient",
    encounterDate: "date",
    medicationPatient: "patient",
    medicationDate: "authoredon",
    conditionPatient: "patient",
  },
} as const;

/** ページ送りの上限（next が自分自身を指し続ける相手で止まらなくなるのを防ぐ） */
const MAX_PAGES = 20;
const ACCEPT = ["application/fhir+json", "application/json"];

/** 保険者番号・公費負担者番号の identifier system（設定で差し替える） */
export const fhirSystems = () => ({
  insurer: connectorEnv(FHIR_ID, "INSURER_SYSTEM") ?? FHIR_WIRE.defaultInsurerSystem,
  kohi: connectorEnv(FHIR_ID, "KOHI_SYSTEM") ?? FHIR_WIRE.defaultKohiSystem,
});

const FhirId = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
/** 日付（YYYY-MM-DD）で始まる値。時刻つき（dateTime）でもよい */
const FhirDay = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/);

export const FhirBundle = z.object({
  resourceType: z.literal("Bundle"),
  type: z.literal("searchset"),
  link: z.array(z.object({ relation: z.string(), url: z.string().max(2000) })).optional(),
  entry: z.array(z.object({ resource: z.object({ resourceType: z.string() }).loose() })).max(1000).optional(),
});

export const FhirPatient = z.object({
  resourceType: z.literal("Patient"),
  id: FhirId,
  name: z.array(z.object({ text: z.string().max(100).optional(), family: z.string().max(50).optional(), given: z.array(z.string().max(50)).optional() })).min(1),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const FhirCoverage = z.object({
  resourceType: z.literal("Coverage"),
  payor: z.array(z.object({ identifier: z.object({ system: z.string().optional(), value: z.string().optional() }).optional() })).min(1),
  extension: z.array(z.object({ url: z.string(), valueString: z.string().max(40).optional() })).optional(),
  subscriberId: z.string().max(40).optional(),
  period: z.object({ start: FhirDay.optional(), end: FhirDay.optional() }).optional(),
});

export const FhirEncounter = z.object({ resourceType: z.literal("Encounter"), period: z.object({ start: FhirDay }) });

export const FhirMedicationRequest = z.object({
  resourceType: z.literal("MedicationRequest"),
  authoredOn: FhirDay,
  medicationCodeableConcept: z.object({ text: z.string().min(1).max(200) }),
});

export const FhirCondition = z.object({
  resourceType: z.literal("Condition"),
  code: z.object({ text: z.string().min(1).max(200) }),
  onsetDateTime: FhirDay.optional(),
});

const day = (s: string | undefined) => (s ? s.slice(0, 10) : null);

/** 検索を 1 つ実行し、next リンクをたどって、指定した種類のリソースを全部集める */
async function searchAll<T>(first: string, resourceType: string, schema: z.ZodType<T>): Promise<T[]> {
  const out: T[] = [];
  let target: string | undefined = first;
  for (let page = 0; target; page++) {
    if (page >= MAX_PAGES) throw new ConnectError(FHIR_ID, "too_large", "ページ送りが上限を超えた");
    // next は相手が返した絶対 URL。connectJson が、設定した接続先の範囲（同じ origin・同じパスの下）の外なら拒否する
    const bundle = FhirBundle.safeParse(await connectJson(FHIR_ID, target, { accept: ACCEPT }));
    if (!bundle.success) throw formatError(FHIR_ID, "Bundle", bundle.error.issues);
    for (const e of bundle.data.entry ?? []) {
      // 検索結果に混ざる別の種類（OperationOutcome など）は読まない
      if (e.resource.resourceType !== resourceType) continue;
      const r = schema.safeParse(e.resource);
      if (!r.success) throw formatError(FHIR_ID, resourceType, r.error.issues);
      out.push(r.data);
    }
    target = bundle.data.link?.find((l) => l.relation === "next")?.url;
  }
  return out;
}

const q = (params: Record<string, string | string[]>) =>
  Object.entries(params)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`))
    .join("&");

export function createFhirConnector(): Connector {
  /** 患者番号から Patient を 1 件引く */
  async function findPatient(patientId: string) {
    assertQuery(patientId, null);
    const system = connectorEnv(FHIR_ID, "PATIENT_SYSTEM");
    if (!system) throw new ConnectError(FHIR_ID, "config", "患者番号の identifier system が設定されていない（RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM）");
    const found = await searchAll(`Patient?${q({ identifier: `${system}|${patientId}` })}`, "Patient", FhirPatient);
    if (found.length === 0) throw new ConnectError(FHIR_ID, "not_found", "患者が見つからない");
    if (found.length > 1) throw new ConnectError(FHIR_ID, "format", "患者番号 1 つに複数の患者が返った");
    return found[0];
  }

  function toCoverage(c: z.infer<typeof FhirCoverage>): ConnectorCoverage | null {
    const systems = fhirSystems();
    const payor = c.payor.map((p) => p.identifier).find((i) => i?.value && (i.system === systems.insurer || i.system === systems.kohi));
    // 番号の system が設定と合わない加入情報は、種類を決められないので写さない
    if (!payor?.value) return null;
    const ext = (url: string) => c.extension?.find((e) => e.url === url)?.valueString ?? "";
    const medical = payor.system === systems.insurer;
    return {
      kind: medical ? "医療保険" : "公費",
      number: payor.value,
      symbol: medical ? ext(FHIR_WIRE.symbolExtension) : "",
      memberNo: medical ? ext(FHIR_WIRE.numberExtension) : (c.subscriberId ?? ""),
      burdenRatio: null,
      validFrom: day(c.period?.start),
      validUntil: day(c.period?.end),
    };
  }

  return {
    id: FHIR_ID,
    label: "HL7 FHIR JP Core 形式（読み取り）",
    patient: {
      async getPatient(patientId): Promise<ConnectorPatient> {
        const p = await findPatient(patientId);
        const coverages = await searchAll(`Coverage?${q({ [FHIR_WIRE.search.coveragePatient]: `Patient/${p.id}` })}`, "Coverage", FhirCoverage);
        const n = p.name[0];
        const name = n.text ?? [n.family ?? "", ...(n.given ?? [])].join("　").trim();
        if (!name) throw new ConnectError(FHIR_ID, "format", "患者の氏名が読めない");
        return {
          patientId,
          name,
          sex: p.gender === "male" ? 1 : p.gender === "female" ? 2 : null,
          birth: p.birthDate,
          coverages: coverages.map(toCoverage).filter((c): c is ConnectorCoverage => c !== null),
        };
      },
    },
    chart: {
      async getChart({ patientId, yearMonth }): Promise<ConnectorChart> {
        assertQuery(patientId, yearMonth);
        const p = await findPatient(patientId);
        const { start, end } = monthRange(yearMonth);
        const s = FHIR_WIRE.search;
        const range = [`ge${start}`, `le${end}`];
        const inMonth = (d: string) => d.startsWith(`${yearMonth}-`);
        const encounters = await searchAll(`Encounter?${q({ [s.encounterPatient]: p.id, [s.encounterDate]: range })}`, "Encounter", FhirEncounter);
        const meds = await searchAll(`MedicationRequest?${q({ [s.medicationPatient]: p.id, [s.medicationDate]: range })}`, "MedicationRequest", FhirMedicationRequest);
        const conditions = await searchAll(`Condition?${q({ [s.conditionPatient]: p.id })}`, "Condition", FhirCondition);
        // 相手が日付の条件を無視しても、診療年月の外のものは返さない
        return {
          patientId,
          yearMonth,
          entries: encounters
            .map((e) => e.period.start.slice(0, 10))
            .filter(inMonth)
            .sort()
            .map((date) => ({ date, s: "", a: "", p: "" })),
          prescriptions: meds
            .map((m) => ({ date: m.authoredOn.slice(0, 10), category: m.medicationCodeableConcept.text }))
            .filter((m) => inMonth(m.date))
            .sort((a, b) => a.date.localeCompare(b.date)),
          diseases: conditions.map((c) => ({ name: c.code.text, start: day(c.onsetDateTime) })),
        };
      },
    },
  };
}
