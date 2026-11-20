// 模擬サーバーの合成データ（fixtures/connect/orca.json・fhir.json）を作り直す。`npx tsx scripts/gen-connect.ts`
// 入力は、症例と同じ合成データ（fixtures/uke/patients.json・fixtures/cases/・fixtures/charts/）。出力は入力だけで決まる。
// 診療年月が変わったら（次の改定など）、gen-uke.ts のあとにこれを回す。年月はここに書かない（config/demo.json から来る）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_PATIENT_SYSTEM } from "../fixtures/connect/mock-server";
import { coverageCsvId, FHIR_WIRE } from "../src/connect/fhir";
import { ORCA_WIRE } from "../src/connect/orca";
import { claimIdOf, dateFrom, monthFrom } from "../src/demo/period";
import { resolveRevision } from "../src/engine/revisions";
import { bundleOfKubun, codeOf } from "../src/engine/revisions/codes";
import type { ClaimContext } from "../src/engine/types";
import type { UkeSources } from "../src/uke/cases";
import type { Chart } from "../src/uke/crosscheck";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = <T>(f: string) => JSON.parse(readFileSync(path.join(root, f), "utf8")) as T;

/** 模擬サーバーが返す患者（症例の番号）と、氏名のカナ（架空の仮置き） */
export const MOCK_PATIENTS: Record<string, string> = { K1: "カクウ　イチロウ", K2: "カクウ　ジロウ", K3:"カクウ　サブロウ", K4: "カクウ　シロウ" };
export const CONNECT_FILES = { orca: "fixtures/connect/orca.json", fhir: "fixtures/connect/fhir.json" } as const;

const iso = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
/** 公費の受給者証の有効期間（架空の仮置き）：基準月の 6 か月前の初日から 1 年間 */
const kohiPeriod = () => {
  const [y, m] = monthFrom(5).split("-").map(Number);
  return { start: dateFrom(-6, 1), end: dateFrom(5, new Date(Date.UTC(y, m, 0)).getUTCDate()) };
};

export function generate(): Record<keyof typeof CONNECT_FILES, string> {
  const { patients, bundleItems } = json<UkeSources>("fixtures/uke/patients.json");
  const kohi = kohiPeriod();
  const orca: Record<string, unknown> = {};
  const medical: Record<string, unknown> = {};
  const resources: unknown[] = [];
  for (const [k, kana] of Object.entries(MOCK_PATIENTS)) {
    const p = patients[claimIdOf(k)];
    if (!p) throw new Error(`患者情報がない: ${k}`);
    const claim = json<ClaimContext>(`fixtures/cases/${k}.json`);
    const ratio = claim.facts.burdenRatio;
    const chart = json<Chart>(`fixtures/charts/${k}.json`);

    // ORCA 形式：診療月診療コード情報（症例の算定行を、診療年月の版の診療行為コードと算定日区分にする。同じ日に 2 回の算定は、この形では表せない）。
    // 包括の検査の区分は、検査項目のコード（EM 5-1。fixtures/uke/patients.json の bundleItems）を 1 行ずつ並べる
    const rev = resolveRevision(claim.yearMonth);
    const facilityResident = claim.facts.residence.known && claim.facts.residence.value === "施設入居等";
    medical[k] = {
      Patient_Information: { Patient_ID: k, WholeName: p.name, BirthDate: iso(p.birth), Sex: String(p.sex) },
      Perform_Date: claim.yearMonth,
      Medical_List_Information: claim.lines.flatMap((l) => {
        const days = new Set(l.dates.map((d) => Number(d.slice(8))));
        if (days.size !== l.count || l.dates.some((d) => !d.startsWith(`${claim.yearMonth}-`))) throw new Error(`算定日区分で表せない行: ${k} ${l.kubun}`);
        const items = bundleOfKubun(rev, l.kubun) ? bundleItems?.[claimIdOf(k)]?.[l.kubun] : [codeOf(rev, l.kubun, facilityResident)];
        if (!items) throw new Error(`包括の検査の項目がない: ${k} ${l.kubun}`);
        return items.map((code) => ({
          Medication_Code: code,
          Medical_Class_code: "0",
          Perform_Total_Number: String(l.count).padStart(2, "0"),
          Perform_Calendar: Array.from({ length: 31 }, (_, i) => (days.has(i + 1) ? "1" : "0")).join(""),
        }));
      }),
    };

    // ORCA 形式：保険組合せの一覧（医療保険だけの組合せと、公費が付く組合せ）
    const insurance = {
      InsuranceProvider_Number: p.insurer.number,
      HealthInsuredPerson_Symbol: p.insurer.symbol,
      HealthInsuredPerson_Number: p.insurer.no,
      Certificate_StartDate: "",
      Certificate_ExpiredDate: "",
    };
    orca[k] = {
      [ORCA_WIRE.patientRoot]: {
        Api_Result: "00",
        Patient_Information: {
          Patient_ID: k,
          WholeName: p.name,
          BirthDate: iso(p.birth),
          Sex: String(p.sex),
          HealthInsurance_Information: [
            { Insurance_Combination_Number: "0001", ...(ratio.known ? { InsuranceCombination_Rate_Outpatient: ratio.value.toFixed(2) } : {}), ...insurance },
            ...p.kohi.map((x, i) => ({
              Insurance_Combination_Number: String(i + 2).padStart(4, "0"),
              ...insurance,
              PublicInsurance_Information: [{ PublicInsurer_Number: x.payerNo, PublicInsuredPerson_Number: x.recipientNo, Certificate_IssuedDate: kohi.start, Certificate_ExpiredDate: kohi.end }],
            })),
          ],
        },
      },
    };

    // FHIR 形式
    const id = `mock-${k}`;
    const meta = (type: keyof typeof FHIR_WIRE.profiles) => ({ profile: [FHIR_WIRE.profiles[type]] });
    const subject = { reference: `Patient/${id}` };
    const rep = (valueCode: string) => [{ url: FHIR_WIRE.nameRepresentation, valueCode }];
    resources.push({
      resourceType: "Patient",
      id,
      meta: meta("Patient"),
      identifier: [{ system: MOCK_PATIENT_SYSTEM, value: k }],
      name: [
        { extension: rep("SYL"), text: kana },
        { extension: rep("IDE"), text: p.name },
      ],
      gender: p.sex === 1 ? "male" : "female",
      birthDate: iso(p.birth),
    });
    resources.push({
      resourceType: "Coverage",
      id: `${id}-cov-1`,
      meta: meta("Coverage"),
      extension: [...(p.insurer.symbol ? [{ url: FHIR_WIRE.symbolExtension, valueString: p.insurer.symbol }] : []), { url: FHIR_WIRE.numberExtension, valueString: p.insurer.no }],
      identifier: [{ system: FHIR_WIRE.coverageCsvSystem, value: coverageCsvId(p.insurer.number, p.insurer.symbol, p.insurer.no) }],
      status: "active",
      beneficiary: subject,
      payor: [{ identifier: { system: FHIR_WIRE.insurerSystem, value: p.insurer.number } }],
    });
    p.kohi.forEach((x, i) =>
      resources.push({
        resourceType: "Coverage",
        id: `${id}-kohi-${i + 1}`,
        meta: meta("Coverage"),
        status: "active",
        beneficiary: subject,
        payor: [{ identifier: { system: FHIR_WIRE.defaultKohiSystem, value: x.payerNo } }],
        subscriberId: x.recipientNo,
        period: kohi,
        order: i + 1,
      }),
    );
    chart.entries.forEach((e, i) =>
      resources.push({ resourceType: "Encounter", id: `${id}-enc-${i + 1}`, meta: meta("Encounter"), status: "finished", subject, period: { start: `${e.date}T10:00:00+09:00` } }),
    );
    chart.prescriptions.forEach((rx, i) =>
      resources.push({ resourceType: "MedicationRequest", id: `${id}-rx-${i + 1}`, meta: meta("MedicationRequest"), status: "active", intent: "order", subject, authoredOn: rx.date, medicationCodeableConcept: { text: rx.category } }),
    );
    p.diseases.forEach((d, i) =>
      resources.push({ resourceType: "Condition", id: `${id}-cond-${i + 1}`, meta: meta("Condition"), subject, code: { text: d.name }, onsetDateTime: iso(d.start) }),
    );
  }
  const who = Object.keys(MOCK_PATIENTS).join("・");
  const out = {
    orca: {
      _note: `模擬サーバー（ORCA API 形式）の応答。合成データ（scripts/gen-connect.ts が作る。手で直さない）。患者は fixtures/uke/patients.json の ${who}、負担割合は fixtures/cases/ の事実から。項目名は日レセ API の公式仕様（patientgetv2）のもの。format=json のときの JSON の形（繰り返しを配列で表す）は未確認の仮定（src/connect/orca.ts の注）。公費の有効期間は架空の仮置き。medical は診療行為（medicalgetv2 class=03）の中身で、模擬サーバーが xml2 形式にして返す。行は fixtures/cases/ の算定行、コードは診療年月の版の診療行為コード（src/engine/revisions/。採用値の表にある行だけ）`,
      patients: orca,
      medical,
    },
    fhir: {
      _note: `模擬サーバー（FHIR JP Core 形式）が返すリソース。合成データ（scripts/gen-connect.ts が作る。手で直さない）。患者・保険・公費・傷病名は fixtures/uke/patients.json、訪問日と処方は fixtures/charts/ の ${who} から。処方は分類名だけ（薬剤名は作らない）。医療保険の identifier・拡張・氏名の表記の拡張は JP Core V1.2.0 の定義どおり。公費負担者番号の identifier system と受給者番号の置き場所は未確認の仮の形（src/connect/fhir.ts の注）。氏名のカナ・訪問の時刻・公費の有効期間は架空の仮置き`,
      resources,
    },
  };
  return { orca: `${JSON.stringify(out.orca, null, 2)}\n`, fhir: `${JSON.stringify(out.fhir, null, 2)}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = generate();
  for (const [key, file] of Object.entries(CONNECT_FILES)) {
    writeFileSync(path.join(root, file), out[key as keyof typeof CONNECT_FILES]);
    console.log(`書き出し: ${file}`);
  }
}
