// ORCA API 形式（日医標準レセプトソフト API）の読み取りコネクタ（spec FR-110）。読み取りだけで、書き込みの API は呼ばない。
// 相手は同梱の模擬サーバー（fixtures/connect/mock-server.ts）。実機にはつないでいない
import { z } from "zod";
import { fictionalCode } from "../engine/codes-fictional";
import { POINTS } from "../engine/points-2024";
import type { ClaimLine, Payer } from "../engine/types";
import { payerOfInsurer } from "../uke/cases";
import type { UkeFile, UkePatient, UkeReceipt } from "../uke/types";
import { readFileSync } from "node:fs";
import { connectJson, ConnectError, connectorEnv, formatError } from "./fetch";
import { assertQuery, monthRange, type ConnectSite, type Connector, type ConnectorCoverage, type ConnectorPatient, type UnmappedLine } from "./types";

export const ORCA_ID = "orca";

// ───────────────────────────────────────────────────────────────────────────
// 通信の形（このコネクタと模擬サーバーが、同じこの定義を使う）
//
// 【確認済み】EM §2-6 O-2〜O-5（確認日 2026-11-17）
//   - 患者基本情報：GET /api01rv2/patientgetv2?id=患者番号。format=json で JSON が返る（ver 5.0 以降）
//   - 診療行為：POST /api01rv2/medicalgetv2。class=03 は「診療月診療行為」
//   - 認証：BASIC 認証（WebORCA クラウドはこれに加えてクライアント証明書。このコネクタは証明書に未対応）
//   - WebORCA はパスの頭に /api が付く → 接続先の URL（RESEMEN_CONNECT_ORCA_URL）の側に書く
//
// 【公式仕様で未確認。実機につなぐ前に確認する】
//   - medicalgetv2 が JSON を受け付け、JSON を返すか（EM O-5「JSON 対応は確認できず」）。
//     ここは JSON 形式が使える前提で止めている。使えない場合は XML（xml2 形式）の読み書きが要り、
//     XML パーサの依存追加（承認が要る。spec FR-115）なしには実機の診療行為を読めない
//   - 下の項目名のすべて（要求・応答の最上位のキー、患者・保険・公費・診療行為の項目名）、
//     性別の値（"1"・"2"）、日付の書式（YYYY-MM-DD）、成功を表す Api_Result の値
//   - 負担割合・レセプト種別・摘要コメントを返す項目（未確認のため写していない）
// ───────────────────────────────────────────────────────────────────────────
export const ORCA_WIRE = {
  patientPath: "api01rv2/patientgetv2",
  medicalPath: "api01rv2/medicalgetv2",
  /** 診療月診療行為 */
  medicalClass: "03",
  // ここから下は未確認
  patientRoot: "patientinfores",
  medicalRequestRoot: "medicalgetreq",
  medicalRoot: "medicalgetres",
  okResults: ["00"],
} as const;

const OrcaDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OrcaDateOrEmpty = z.union([OrcaDate, z.literal("")]).optional();
const Digits = (re: RegExp) => z.string().regex(re);

/** 未確認の形（上の注を参照）。公費 1 件 */
const OrcaPublicInsurance = z.object({
  PublicInsurer_Number: Digits(/^\d{8}$/),
  PublicInsuredPerson_Number: Digits(/^\d{1,8}$/),
  Certificate_IssuedDate: OrcaDateOrEmpty,
  Certificate_ExpiredDate: OrcaDateOrEmpty,
});

/** 未確認の形。保険の組み合わせ 1 件（医療保険 1 つと、それに付く公費） */
const OrcaHealthInsurance = z.object({
  InsuranceProvider_Number: Digits(/^(\d{6}|\d{8})$/),
  HealthInsuredPerson_Symbol: z.string().max(40).optional(),
  HealthInsuredPerson_Number: z.string().min(1).max(40),
  Certificate_StartDate: OrcaDateOrEmpty,
  Certificate_ExpiredDate: OrcaDateOrEmpty,
  PublicInsurance_Information: z.array(OrcaPublicInsurance).max(10).optional(),
});

const OrcaResult = { Api_Result: z.string().regex(/^[0-9A-Za-z]{1,4}$/) };

/** 未確認の形。患者基本情報の応答 */
export const OrcaPatientResponse = z.object({
  [ORCA_WIRE.patientRoot]: z.object({
    ...OrcaResult,
    Patient_Information: z
      .object({
        Patient_ID: z.string(),
        WholeName: z.string().min(1).max(100),
        BirthDate: OrcaDate,
        Sex: z.enum(["1", "2"]),
        HealthInsurance_Information: z.array(OrcaHealthInsurance).max(20).optional(),
      })
      .optional(),
  }),
});

/** 未確認の形。診療月診療行為の応答（診療行為コードごとに、算定した日） */
export const OrcaMedicalResponse = z.object({
  [ORCA_WIRE.medicalRoot]: z.object({
    ...OrcaResult,
    Patient_Information: z.object({ Patient_ID: z.string() }).optional(),
    Perform_Month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    Medical_Information: z
      .array(z.object({ Medication_Code: Digits(/^\d{9}$/), Perform_Dates: z.array(OrcaDate).min(1).max(31) }))
      .max(500)
      .optional(),
  }),
});

/** 未確認の形。診療行為の要求の本文 */
export const orcaMedicalRequest = (patientId: string, yearMonth: string) => ({
  [ORCA_WIRE.medicalRequestRoot]: { Patient_ID: patientId, Perform_Date: `${yearMonth}-01`, InOut: "O" },
});

/**
 * 診療行為コード → このアプリの区分 の対応表。
 * 同梱するのは架空コード（src/engine/codes-fictional.ts）だけ。実在のマスターとの対応表は同梱しない。
 * 差し替えるときは RESEMEN_CONNECT_ORCA_CODEMAP に JSON（{"コード": "区分"}）のパスを書く
 */
export function loadCodeMap(): Map<string, string> {
  const file = connectorEnv(ORCA_ID, "CODEMAP");
  if (!file) return new Map(Object.keys(POINTS).map((kubun) => [fictionalCode(kubun), kubun]));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConnectError(ORCA_ID, "config", "対応表（RESEMEN_CONNECT_ORCA_CODEMAP）が読めない");
  }
  const parsed = z.record(z.string(), z.string()).safeParse(raw);
  if (!parsed.success) throw new ConnectError(ORCA_ID, "config", "対応表（RESEMEN_CONNECT_ORCA_CODEMAP）の形が違う");
  return new Map(Object.entries(parsed.data));
}

const orEmpty = (d: string | undefined) => d || null;

function toPatient(patientId: string, raw: unknown): ConnectorPatient {
  const parsed = OrcaPatientResponse.safeParse(raw);
  if (!parsed.success) throw formatError(ORCA_ID, "患者基本情報", parsed.error.issues);
  const res = parsed.data[ORCA_WIRE.patientRoot];
  if (!(ORCA_WIRE.okResults as readonly string[]).includes(res.Api_Result)) throw new ConnectError(ORCA_ID, "upstream", `相手が失敗の結果を返した（Api_Result ${res.Api_Result}）`);
  const p = res.Patient_Information;
  if (!p) throw formatError(ORCA_ID, "患者基本情報", [{ path: [ORCA_WIRE.patientRoot, "Patient_Information"] }]);
  if (p.Patient_ID !== patientId) throw new ConnectError(ORCA_ID, "format", "頼んだ患者と違う患者の応答が返った");
  // 応答は「保険の組み合わせ」の一覧なので、同じ医療保険・同じ公費が何度も出る。重ねて数えない
  const coverages = new Map<string, ConnectorCoverage>();
  for (const h of p.HealthInsurance_Information ?? []) {
    const symbol = h.HealthInsuredPerson_Symbol ?? "";
    coverages.set(`医療保険/${h.InsuranceProvider_Number}/${symbol}/${h.HealthInsuredPerson_Number}`, {
      kind: "医療保険",
      number: h.InsuranceProvider_Number,
      symbol,
      memberNo: h.HealthInsuredPerson_Number,
      burdenRatio: null,
      validFrom: orEmpty(h.Certificate_StartDate),
      validUntil: orEmpty(h.Certificate_ExpiredDate),
    });
    for (const k of h.PublicInsurance_Information ?? []) {
      coverages.set(`公費/${k.PublicInsurer_Number}/${k.PublicInsuredPerson_Number}`, {
        kind: "公費",
        number: k.PublicInsurer_Number,
        symbol: "",
        memberNo: k.PublicInsuredPerson_Number,
        burdenRatio: null,
        validFrom: orEmpty(k.Certificate_IssuedDate),
        validUntil: orEmpty(k.Certificate_ExpiredDate),
      });
    }
  }
  return { patientId, name: p.WholeName, sex: Number(p.Sex) as 1 | 2, birth: p.BirthDate, coverages: [...coverages.values()] };
}

/**
 * 患者基本情報を、UKE の患者・保険の形にする。診療年月に有効な医療保険がちょうど 1 件のときだけ決まる。
 * レセプト種別と傷病名は、このコネクタでは取っていない（空で返す。返す項目・API が未確認のため）
 */
export function toUkePatient(p: ConnectorPatient, yearMonth: string): UkePatient {
  const { start, end } = monthRange(yearMonth);
  const valid = p.coverages.filter((c) => (c.validFrom ?? "0000") <= end && (c.validUntil ?? "9999") >= start);
  const medical = valid.filter((c) => c.kind === "医療保険");
  if (medical.length !== 1 || p.sex === null) throw new ConnectError(ORCA_ID, "format", "診療年月に有効な医療保険が 1 件に決まらない、または性別がない");
  return {
    name: p.name,
    sex: p.sex,
    birth: p.birth.replaceAll("-", ""),
    receiptType: "",
    insurer: { number: medical[0].number, symbol: medical[0].symbol, no: medical[0].memberNo },
    kohi: valid.filter((c) => c.kind === "公費").map((c) => ({ payerNo: c.number, recipientNo: c.memberNo })),
    diseases: [],
  };
}

const nextMonth = (yearMonth: string) => {
  const [y, m] = yearMonth.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

export function createOrcaConnector(site: ConnectSite): Connector {
  const accept = ["application/json"];

  async function getPatient(patientId: string): Promise<ConnectorPatient> {
    assertQuery(patientId, null);
    const raw = await connectJson(ORCA_ID, `${ORCA_WIRE.patientPath}?id=${encodeURIComponent(patientId)}&format=json`, { accept });
    return toPatient(patientId, raw);
  }

  async function getLines(patientId: string, yearMonth: string, claimId: string, codeMap: Map<string, string>) {
    const raw = await connectJson(ORCA_ID, `${ORCA_WIRE.medicalPath}?class=${ORCA_WIRE.medicalClass}&format=json`, {
      method: "POST",
      body: orcaMedicalRequest(patientId, yearMonth),
      accept,
    });
    const parsed = OrcaMedicalResponse.safeParse(raw);
    if (!parsed.success) throw formatError(ORCA_ID, "診療行為", parsed.error.issues);
    const res = parsed.data[ORCA_WIRE.medicalRoot];
    if (!(ORCA_WIRE.okResults as readonly string[]).includes(res.Api_Result)) throw new ConnectError(ORCA_ID, "upstream", `相手が失敗の結果を返した（Api_Result ${res.Api_Result}）`);
    const lines: ClaimLine[] = [];
    const unmapped: UnmappedLine[] = [];
    for (const m of res.Medical_Information ?? []) {
      if (m.Perform_Dates.some((d) => !d.startsWith(`${yearMonth}-`))) throw new ConnectError(ORCA_ID, "format", "頼んだ診療年月の外の日付が返った");
      const kubun = codeMap.get(m.Medication_Code);
      // 対応のないコード（対応表にない・対応先がこのアプリの区分にない）は例外にせず、判定の対象外として返す（spec FR-111）
      if (kubun === undefined || !(kubun in POINTS)) unmapped.push({ claimId, code: m.Medication_Code, dates: m.Perform_Dates });
      else lines.push({ kubun, count: m.Perform_Dates.length, dates: m.Perform_Dates });
    }
    return { lines, unmapped };
  }

  return {
    id: ORCA_ID,
    label: "ORCA API 形式（読み取り）",
    patient: { getPatient },
    claims: {
      async getClaims({ yearMonth, patientIds }) {
        if (!patientIds) throw new Error("ORCA 形式のコネクタでは、患者の id の指定が要る");
        assertQuery(null, yearMonth);
        const codeMap = loadCodeMap();
        const receipts: Record<Payer, UkeReceipt[]> = { 国保連: [], 支払基金: [] };
        const unmapped: UnmappedLine[] = [];
        for (const patientId of patientIds) {
          const claimId = `${patientId}-${yearMonth}`;
          const patient = toUkePatient(await getPatient(patientId), yearMonth);
          const got = await getLines(patientId, yearMonth, claimId, codeMap);
          receipts[payerOfInsurer(patient.insurer.number)].push({ claimId, yearMonth, patient, lines: got.lines, comments: [] });
          unmapped.push(...got.unmapped);
        }
        const files: UkeFile[] = (["国保連", "支払基金"] as const)
          .filter((payer) => receipts[payer].length > 0)
          .map((payer) => ({ payer, prefecture: site.prefecture, clinic: site.clinic, billingMonth: nextMonth(yearMonth), receipts: receipts[payer] }));
        return { files, unmapped };
      },
    },
  };
}
