// HL7 FHIR（JP Core）形式の読み取りコネクタ（spec FR-110）。検索（searchset の Bundle）を読むだけで、書き込みはしない。
// 相手は同梱の模擬サーバー（fixtures/connect/mock-server.ts）。実機にはつないでいない
import { z } from "zod";
import { monthRange } from "../demo/period";
import { connectJson, ConnectError, connectorEnv, formatError } from "./fetch";
import type { CoverageInfo } from "../patient/profile";
import { assertQuery, type Connector, type ConnectorChart, type ConnectorPatient } from "./types";

export const FHIR_ID = "fhir";

// ───────────────────────────────────────────────────────────────────────────
// 通信の形（このコネクタと模擬サーバーが、同じこの定義を使う）。出典と確認日は docs/connectors.md
//
// 【公式仕様で確認済み】JP Core V1.2.0（FHIR 4.0.1。https://jpfhir.jp/fhir/core/1.2.0/ 。2026-11-17 に一次資料を読んだ）
//   JP_Patient（StructureDefinition-jp-patient）
//   - 患者番号の検索（SHALL）：Patient?identifier=urn:oid:1.2.392.100495.20.3.51.1[医療機関コード10桁]|患者番号
//     → system の全体を RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM に書く（医療機関ごとに違うので既定値を持たない）
//   - 氏名は JP_HumanName。漢字・カナ・ローマ字は、name の拡張 iso21090-EN-representation（IDE｜SYL）で見分ける
//   JP_Coverage（StructureDefinition-jp-coverage）
//   - 検索（SHOULD）：Coverage?beneficiary=[reference]
//   - 医療保険：identifier（system＝…/IdSystem/JP_Coverage_id）に、保険者番号・記号・番号・枝番を
//     "{保険者番号:半角英数８桁}","{記号}","{番号}","{枝番}" の形で持つ（記号・番号・枝番は全角にして書く）。
//     別の形として identifier（system＝…/clins/Idsystem/JP_Insurance_memberID）＝ 保険者番号:記号:番号:枝番（保険者番号は先頭にゼロを足して 8 桁）
//   - 記号・番号の拡張 JP_Coverage_InsuredPersonSymbol／…Number（値は valueString）
//   - period：保険証または公費の有効期間の開始日・終了日（yyyy-mm-dd）
//   - payor：医療保険は保険者の Organization、公費は公費負担者の Organization への参照。
//     保険者番号の identifier system（JP_Organization）＝ http://jpfhir.jp/fhir/core/mhlw/IdSystem/InsurerNumber
//   JP_Encounter：検索（SHOULD）Encounter?date=…&patient=Patient/[id]
//   JP_MedicationRequest：検索（SHOULD）MedicationRequest?patient=[id]&authoredon=…。medication[x] は CodeableConcept、authoredOn は必須
//   JP_Condition：検索（SHOULD）Condition?patient=Patient/[id]
//
// 【公式仕様で未確認。実機につなぐ前に確認する】
//   - 公費負担者番号の置き場所と identifier system（payor の Organization の identifier と読めるが、保険者番号の system を
//     公費にも使うかは書かれていない）。下の既定値は置き場所を示すだけの仮の値で、RESEMEN_CONNECT_FHIR_KOHI_SYSTEM で差し替える。
//     payor を、Organization を引かずに論理参照（payor[].identifier）で読むことも仮定
//   - 公費の受給者番号の置き場所（JP_Coverage に記載が見つからない。Coverage.subscriberId と仮定）
//   - 負担割合：置き場所は costToBeneficiary（type は coverage-copay-type の copaypct。「公費の場合には自己負担率」）と確認したが、
//     値の単位（30 か 0.3 か）が書かれていないので写していない
//   - 検索の SHOULD の項目を相手のサーバーが実装しているか。date・authoredon に ge／le を 2 つ並べる書き方（仕様の例は eq だけ）
//   - 訪問診療の Encounter の見分け方（class の値を確認していない。期間内の Encounter をすべて訪問日として返す）
//   - 薬剤・傷病名の表示名を CodeableConcept の text（なければ coding[0].display）から読むこと
//   - ページ送り（Bundle.link の next）は FHIR R4 本体の仕様。JP Core の文書では確かめていない
// ───────────────────────────────────────────────────────────────────────────
export const FHIR_WIRE = {
  profiles: {
    Patient: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Patient",
    Coverage: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Coverage",
    Encounter: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Encounter",
    MedicationRequest: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_MedicationRequest",
    Condition: "http://jpfhir.jp/fhir/core/StructureDefinition/JP_Condition",
  },
  /** 被保険者識別子（CSV 形式） */
  coverageCsvSystem: "http://jpfhir.jp/fhir/core/IdSystem/JP_Coverage_id",
  /** 被保険者個人識別子（コロン区切り） */
  coverageMemberSystem: "http://jpfhir.jp/fhir/clins/Idsystem/JP_Insurance_memberID",
  symbolExtension: "http://jpfhir.jp/fhir/core/Extension/StructureDefinition/JP_Coverage_InsuredPersonSymbol",
  numberExtension: "http://jpfhir.jp/fhir/core/Extension/StructureDefinition/JP_Coverage_InsuredPersonNumber",
  insurerSystem: "http://jpfhir.jp/fhir/core/mhlw/IdSystem/InsurerNumber",
  nameRepresentation: "http://hl7.org/fhir/StructureDefinition/iso21090-EN-representation",
  search: {
    coveragePatient: "beneficiary",
    encounterPatient: "patient",
    encounterDate: "date",
    medicationPatient: "patient",
    medicationDate: "authoredon",
    conditionPatient: "patient",
  },
  // ここから下は未確認
  defaultKohiSystem: "urn:example:resemen:unconfirmed:kohi-payer-number",
} as const;

/** ページ送りの上限（next が自分自身を指し続ける相手で止まらなくなるのを防ぐ） */
const MAX_PAGES = 20;
const ACCEPT = ["application/fhir+json", "application/json"];

/** 公費負担者番号の identifier system（未確認。設定で差し替える） */
export const kohiSystem = () => connectorEnv(FHIR_ID, "KOHI_SYSTEM") ?? FHIR_WIRE.defaultKohiSystem;

const FhirId = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
/** 日付（YYYY-MM-DD）で始まる値。時刻つき（dateTime）でもよい */
const FhirDay = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/);
const Identifier = z.object({ system: z.string().optional(), value: z.string().max(200).optional() });
/** 表示名を持つコード（text、なければ coding[0].display を読む） */
const Concept = z.object({ text: z.string().max(200).optional(), coding: z.array(z.object({ display: z.string().max(200).optional() })).optional() });
const conceptName = (c: z.infer<typeof Concept>) => c.text || c.coding?.find((x) => x.display)?.display || "";

export const FhirBundle = z.object({
  resourceType: z.literal("Bundle"),
  type: z.literal("searchset"),
  link: z.array(z.object({ relation: z.string(), url: z.string().max(2000) })).optional(),
  entry: z.array(z.object({ resource: z.object({ resourceType: z.string() }).loose() })).max(1000).optional(),
});

export const FhirPatient = z.object({
  resourceType: z.literal("Patient"),
  id: FhirId,
  name: z
    .array(
      z.object({
        extension: z.array(z.object({ url: z.string(), valueCode: z.string().optional() })).optional(),
        text: z.string().max(100).optional(),
        family: z.string().max(50).optional(),
        given: z.array(z.string().max(50)).optional(),
      }),
    )
    .min(1),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const FhirCoverage = z.object({
  resourceType: z.literal("Coverage"),
  identifier: z.array(Identifier).optional(),
  payor: z.array(z.object({ identifier: Identifier.optional() })).min(1),
  extension: z.array(z.object({ url: z.string(), valueString: z.string().max(40).optional() })).optional(),
  subscriberId: z.string().max(40).optional(),
  period: z.object({ start: FhirDay.optional(), end: FhirDay.optional() }).optional(),
});

export const FhirEncounter = z.object({ resourceType: z.literal("Encounter"), period: z.object({ start: FhirDay }) });
export const FhirMedicationRequest = z.object({ resourceType: z.literal("MedicationRequest"), authoredOn: FhirDay, medicationCodeableConcept: Concept });
export const FhirCondition = z.object({ resourceType: z.literal("Condition"), code: Concept, onsetDateTime: FhirDay.optional() });

const day = (s: string | undefined) => (s ? s.slice(0, 10) : null);

/** 被保険者識別子（CSV 形式）を作る。記号・番号は全角、保険者番号（8 桁）と枝番（2 桁）は半角で書く決まり（模擬サーバーのデータを作るのにも使う） */
export function coverageCsvId(insurerNumber: string, symbol: string, memberNo: string, branch = ""): string {
  const wide = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  return [insurerNumber.padStart(8, "0"), wide(symbol), wide(memberNo), branch].map((x) => `"${x}"`).join(",");
}

/**
 * Coverage の identifier から、保険者番号・記号・番号を読む（医療保険だけが持つ）。
 * 保険者番号は 8 桁に満たないと先頭にゼロを足す決まりなので、00 で始まる 8 桁は 6 桁（国保）に戻す。
 * CSV 形式の記号・番号は全角にして書く決まりなので、半角に戻す（NFKC）。コロン区切りの形は券面のままなので、そのまま写す
 */
function insuredOf(c: z.infer<typeof FhirCoverage>): { number: string; symbol: string; memberNo: string } | null {
  const of = (system: string) => c.identifier?.find((i) => i.system === system)?.value;
  const csv = /^"([^"]*)","([^"]*)","([^"]*)","([^"]*)"$/.exec(of(FHIR_WIRE.coverageCsvSystem) ?? "");
  const colon = (of(FHIR_WIRE.coverageMemberSystem) ?? "").split(":");
  const parts = csv ? csv.slice(1, 4).map((x) => x.normalize("NFKC")) : colon.length === 4 ? colon.slice(0, 3) : null;
  if (!parts || !/^\d{8}$/.test(parts[0]) || !parts[2]) return null;
  return { number: parts[0].replace(/^00(?=\d{6}$)/, ""), symbol: parts[1], memberNo: parts[2] };
}

/** Coverage 1 件を加入情報にする。医療保険とも公費とも読めなければ null */
export function toCoverage(c: z.infer<typeof FhirCoverage>): CoverageInfo | null {
  const rest = { burdenRatio: null, validFrom: day(c.period?.start), validUntil: day(c.period?.end) };
  const insured = insuredOf(c);
  if (insured) {
    // 記号・番号の拡張があれば、そちらを採る（券面どおりの値）
    const ext = (url: string) => c.extension?.find((e) => e.url === url)?.valueString;
    return { kind: "医保", payerNumber: insured.number, symbol: ext(FHIR_WIRE.symbolExtension) ?? insured.symbol, memberNo: ext(FHIR_WIRE.numberExtension) ?? insured.memberNo, ...rest };
  }
  // 公費（置き場所は未確認。上の注）
  const system = kohiSystem();
  const payer = c.payor.map((p) => p.identifier).find((i) => i?.value && i.system === system);
  // 医療保険とも公費とも読めない加入情報は、種類を決められないので写さない
  if (!payer?.value) return null;
  return { kind: "公費", payerNumber: payer.value, symbol: "", memberNo: c.subscriberId ?? "", ...rest };
}

/** 氏名。漢字の表記（IDE）を採る。印がなければ、カナ（SYL）でない最初の名前 */
function nameOf(p: z.infer<typeof FhirPatient>): string {
  const rep = (n: (typeof p.name)[number]) => n.extension?.find((e) => e.url === FHIR_WIRE.nameRepresentation)?.valueCode;
  const n = p.name.find((x) => rep(x) === "IDE") ?? p.name.find((x) => rep(x) !== "SYL") ?? p.name[0];
  return n.text ?? [n.family ?? "", ...(n.given ?? [])].join("　").trim();
}

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

  return {
    id: FHIR_ID,
    label: "HL7 FHIR JP Core 形式（読み取り）",
    patient: {
      async getPatient(patientId): Promise<ConnectorPatient> {
        const p = await findPatient(patientId);
        const coverages = await searchAll(`Coverage?${q({ [FHIR_WIRE.search.coveragePatient]: `Patient/${p.id}` })}`, "Coverage", FhirCoverage);
        const name = nameOf(p);
        if (!name) throw new ConnectError(FHIR_ID, "format", "患者の氏名が読めない");
        return {
          patientId,
          name,
          sex: p.gender === "male" ? 1 : p.gender === "female" ? 2 : null,
          birth: p.birthDate.replaceAll("-", ""),
          coverages: coverages.map(toCoverage).filter((c): c is CoverageInfo => c !== null),
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
        const ref = `Patient/${p.id}`;
        const inMonth = (d: string) => d.startsWith(`${yearMonth}-`);
        const encounters = await searchAll(`Encounter?${q({ [s.encounterDate]: range, [s.encounterPatient]: ref })}`, "Encounter", FhirEncounter);
        const meds = await searchAll(`MedicationRequest?${q({ [s.medicationPatient]: p.id, [s.medicationDate]: range })}`, "MedicationRequest", FhirMedicationRequest);
        const conditions = await searchAll(`Condition?${q({ [s.conditionPatient]: ref })}`, "Condition", FhirCondition);
        // 相手が日付の条件を無視しても、診療年月の外のものは返さない。表示名のないものは写さない
        return {
          patientId,
          yearMonth,
          entries: encounters
            .map((e) => e.period.start.slice(0, 10))
            .filter(inMonth)
            .sort()
            .map((date) => ({ date, s: "", a: "", p: "" })),
          prescriptions: meds
            .map((m) => ({ date: m.authoredOn.slice(0, 10), category: conceptName(m.medicationCodeableConcept) }))
            .filter((m) => inMonth(m.date) && m.category)
            .sort((a, b) => a.date.localeCompare(b.date)),
          diseases: conditions.map((c) => ({ name: conceptName(c.code), start: day(c.onsetDateTime) })).filter((d) => d.name),
        };
      },
    },
  };
}
