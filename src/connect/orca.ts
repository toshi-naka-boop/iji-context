// ORCA API 形式（日医標準レセプトソフト API）の読み取りコネクタ（spec FR-110）。読み取りだけで、書き込みの API は呼ばない。
// 相手は同梱の模擬サーバー（fixtures/connect/mock-server.ts）。実機にはつないでいない。
// 持っているのは患者基本情報（PatientSource）だけ。請求（診療行為）は、公式仕様が xml2 形式だけなので読んでいない（下の注）
import { readFileSync } from "node:fs";
import { z } from "zod";
import { CODE_TABLE } from "../engine/codes-fictional";
import { hasRevision, resolveRevision } from "../engine/revisions";
import type { ClaimLine } from "../engine/types";
import type { CoverageInfo } from "../patient/profile";
import { connectJson, ConnectError, connectorEnv, formatError } from "./fetch";
import { assertQuery, type Connector, type ConnectorPatient, type UnmappedLine } from "./types";

export const ORCA_ID = "orca";

// ───────────────────────────────────────────────────────────────────────────
// 通信の形（このコネクタと模擬サーバーが、同じこの定義を使う）。出典と確認日は docs/connectors.md
//
// 【公式仕様で確認済み】（2026-11-17 に一次資料を読んだ）
//   概要 https://www.orca.med.or.jp/receipt/tec/api/
//   - 呼び出し方（http://ホスト:8000/パス。WebORCA はパスの頭に /api → 接続先の URL の側に書く）
//   - 認証：オンプレは BASIC 認証（または SSL クライアント認証）、クラウドは BASIC 認証＋クライアント証明書（未対応）
//   患者基本情報 https://www.orca.med.or.jp/receipt/tec/api/patientget.html（更新履歴の最新 2026-08-25）
//   - GET /api01rv2/patientgetv2?id=患者番号。ver 5.0 以降は format=json で JSON でも返る
//   - 応答の最上位 patientinfores、Api_Result（「ゼロ以外エラー」。10＝患者番号に該当する患者が存在しません）
//   - Patient_Information の Patient_ID・WholeName・BirthDate（YYYY-MM-DD）・Sex（1 男性、2 女性）
//   - HealthInsurance_Information（保険組合せ。繰り返し 30）の InsuranceCombination_Rate_Outpatient（外来負担割合。例 0.30）・
//     InsuranceProvider_Number・HealthInsuredPerson_Symbol・HealthInsuredPerson_Number・Certificate_StartDate・Certificate_ExpiredDate
//   - PublicInsurance_Information（公費。繰り返し 4）の PublicInsurer_Number・PublicInsuredPerson_Number・
//     Certificate_IssuedDate（適用開始日）・Certificate_ExpiredDate
//   診療行為 https://www.orca.med.or.jp/receipt/tec/api/medicalinfo.html（更新履歴の最新 2026-07-28）
//   - POST /api01rv2/medicalgetv2。「リクエストおよびレスポンスデータは xml2 形式」。Content-Type は application/xml。
//     format=json の記載はない → JSON では読めないものとして扱い、このコネクタは請求（ClaimSource）を持たない。
//     読むには XML（xml2 形式）の読み書きが要り、XML パーサの依存追加（承認が要る。spec FR-115）が前提になる
//   - class=03（診療月診療コード情報）の応答の項目：Perform_Date（診療年月 YYYY-MM）、Medical_List_Information（繰り返し 400）の
//     Medication_Code・Perform_Calendar（算定した日に 1、それ以外に 0 を並べた 31 文字）。日付はここから作れる
//   患者病名 https://www.orca.med.or.jp/receipt/tec/api/disease.html：POST /api01rv2/diseasegetv2。これも xml2 形式だけ（読んでいない）
//
// 【公式仕様で未確認。実機につなぐ前に確認する】
//   - format=json のときの JSON の形（最上位のキーが patientinfores のままか、xml2 の「〜_child」の繰り返しが配列になるか）。
//     仕様ページにあるのは xml2 のサンプルだけ。下のスキーマは「同じ項目名で、繰り返しは配列」と仮定している
//   - 記号・番号が全角で返るか（仕様の例は全角。このコネクタは返ったまま写す）
//   - 適用終了日 9999-12-31 の意味（仕様の例に出る。期限なしと読めるが明記はない。返ったまま写す）
//   - 公費の Rate_Outpatient（「外来ー負担率(割)」）の単位。未確認のため写していない
// ───────────────────────────────────────────────────────────────────────────
export const ORCA_WIRE = {
  patientPath: "api01rv2/patientgetv2",
  patientRoot: "patientinfores",
  /** 「患者番号に該当する患者が存在しません」 */
  notFoundResult: "10",
} as const;

/** Api_Result は「ゼロ以外エラー」 */
const isOk = (result: string) => /^0+$/.test(result);

const OrcaDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OrcaDateOrEmpty = z.union([OrcaDate, z.literal("")]).optional();

/** 公費 1 件 */
const OrcaPublicInsurance = z.object({
  PublicInsurer_Number: z.string().regex(/^\d{8}$/),
  PublicInsuredPerson_Number: z.string().min(1).max(20),
  Certificate_IssuedDate: OrcaDateOrEmpty,
  Certificate_ExpiredDate: OrcaDateOrEmpty,
});

/** 保険組合せ 1 件（医療保険 1 つと、それに付く公費）。公費だけの組合せは保険者番号を持たないことがあるので、省略を許す */
const OrcaHealthInsurance = z.object({
  InsuranceCombination_Rate_Outpatient: z.string().regex(/^[01]\.\d{1,2}$/).optional(),
  InsuranceProvider_Number: z.union([z.string().regex(/^(\d{6}|\d{8})$/), z.literal("")]).optional(),
  HealthInsuredPerson_Symbol: z.string().max(40).optional(),
  HealthInsuredPerson_Number: z.string().max(40).optional(),
  Certificate_StartDate: OrcaDateOrEmpty,
  Certificate_ExpiredDate: OrcaDateOrEmpty,
  PublicInsurance_Information: z.array(OrcaPublicInsurance).max(4).optional(),
});

/** 患者基本情報の応答（JSON の形は未確認。上の注） */
export const OrcaPatientResponse = z.object({
  [ORCA_WIRE.patientRoot]: z.object({
    Api_Result: z.string().regex(/^[0-9A-Za-z]{1,4}$/),
    Patient_Information: z
      .object({
        Patient_ID: z.string(),
        WholeName: z.string().min(1).max(100),
        BirthDate: OrcaDate,
        Sex: z.enum(["1", "2"]),
        HealthInsurance_Information: z.array(OrcaHealthInsurance).max(30).optional(),
      })
      .optional(),
  }),
});

const orEmpty = (d: string | undefined) => d || null;

function toPatient(patientId: string, raw: unknown): ConnectorPatient {
  const parsed = OrcaPatientResponse.safeParse(raw);
  if (!parsed.success) throw formatError(ORCA_ID, "患者基本情報", parsed.error.issues);
  const res = parsed.data[ORCA_WIRE.patientRoot];
  if (res.Api_Result === ORCA_WIRE.notFoundResult) throw new ConnectError(ORCA_ID, "not_found", "患者が見つからない");
  if (!isOk(res.Api_Result)) throw new ConnectError(ORCA_ID, "upstream", `相手が失敗の結果を返した（Api_Result ${res.Api_Result}）`);
  const p = res.Patient_Information;
  if (!p) throw formatError(ORCA_ID, "患者基本情報", [{ path: [ORCA_WIRE.patientRoot, "Patient_Information"] }]);
  if (p.Patient_ID !== patientId) throw new ConnectError(ORCA_ID, "format", "頼んだ患者と違う患者の応答が返った");
  // 応答は「保険組合せ」の一覧なので、同じ医療保険・同じ公費が何度も出る。重ねて数えない
  const coverages = new Map<string, CoverageInfo>();
  for (const h of p.HealthInsurance_Information ?? []) {
    const publics = h.PublicInsurance_Information ?? [];
    if (h.InsuranceProvider_Number && h.HealthInsuredPerson_Number) {
      const symbol = h.HealthInsuredPerson_Symbol ?? "";
      const key = `医療保険/${h.InsuranceProvider_Number}/${symbol}/${h.HealthInsuredPerson_Number}`;
      // 負担割合は組合せごとの値。医療保険そのものの割合として使うのは、公費の付かない組合せの値だけ
      const rate = publics.length === 0 && h.InsuranceCombination_Rate_Outpatient ? Number(h.InsuranceCombination_Rate_Outpatient) : null;
      coverages.set(key, {
        kind: "医保",
        payerNumber: h.InsuranceProvider_Number,
        symbol,
        memberNo: h.HealthInsuredPerson_Number,
        burdenRatio: rate ?? coverages.get(key)?.burdenRatio ?? null,
        validFrom: orEmpty(h.Certificate_StartDate),
        validUntil: orEmpty(h.Certificate_ExpiredDate),
      });
    }
    for (const k of publics) {
      coverages.set(`公費/${k.PublicInsurer_Number}/${k.PublicInsuredPerson_Number}`, {
        kind: "公費",
        payerNumber: k.PublicInsurer_Number,
        symbol: "",
        memberNo: k.PublicInsuredPerson_Number,
        burdenRatio: null,
        validFrom: orEmpty(k.Certificate_IssuedDate),
        validUntil: orEmpty(k.Certificate_ExpiredDate),
      });
    }
  }
  return { patientId, name: p.WholeName, sex: Number(p.Sex) as 1 | 2, birth: p.BirthDate.replaceAll("-", ""), coverages: [...coverages.values()] };
}

export function createOrcaConnector(): Connector {
  return {
    id: ORCA_ID,
    label: "ORCA API 形式（読み取り・患者基本情報）",
    patient: {
      async getPatient(patientId) {
        assertQuery(patientId, null);
        const raw = await connectJson(ORCA_ID, `${ORCA_WIRE.patientPath}?id=${encodeURIComponent(patientId)}&format=json`);
        return toPatient(patientId, raw);
      },
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 診療月診療コード情報（medicalgetv2 class=03）→ 算定行。通信はしない。
// xml2 形式を読めるようになったとき（依存の承認後）に、読んだ結果をここへ渡す。項目名は公式仕様で確認済み（上の注）。
// いまはどのコネクタからも呼ばれていない（対応のないコードの扱い＝spec FR-111 を、コードと一緒に残すために置いている）
// ───────────────────────────────────────────────────────────────────────────
export const OrcaMedicalMonth = z.object({
  /** 診療年月 YYYY-MM */
  Perform_Date: z.string().regex(/^\d{4}-\d{2}$/),
  Medical_List_Information: z
    .array(z.object({ Medication_Code: z.string().regex(/^\d{9}$/), Perform_Calendar: z.string().regex(/^[01]{31}$/) }))
    .max(400)
    .optional(),
});

/**
 * 診療行為コード → このアプリの区分 の対応表。
 * 同梱するのは架空コード（src/engine/codes-fictional.ts）だけ。実在のマスターとの対応表は同梱しない。
 * 差し替えるときは RESEMEN_CONNECT_ORCA_CODEMAP に JSON（{"コード": "区分"}）のパスを書く
 */
export function loadCodeMap(): Map<string, string> {
  const file = connectorEnv(ORCA_ID, "CODEMAP");
  if (!file) return new Map(CODE_TABLE.map((r) => [r.code, r.kubun]));
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

/** 診療月診療コード情報を算定行にする。対応のないコードは例外にせず unmapped に入れる（判定の対象外） */
export function medicalMonthToLines(raw: unknown, query: { claimId: string; yearMonth: string }, codeMap = loadCodeMap()): { lines: ClaimLine[]; unmapped: UnmappedLine[] } {
  const parsed = OrcaMedicalMonth.safeParse(raw);
  if (!parsed.success) throw formatError(ORCA_ID, "診療行為", parsed.error.issues);
  if (parsed.data.Perform_Date !== query.yearMonth) throw new ConnectError(ORCA_ID, "format", "頼んだ診療年月と違う月の応答が返った");
  // 該当する版がない診療年月は判定しない（近い版で代用しない）
  if (!hasRevision(query.yearMonth)) throw new ConnectError(ORCA_ID, "format", "診療年月に当たる版がない");
  const points = resolveRevision(query.yearMonth).points;
  const lines: ClaimLine[] = [];
  const unmapped: UnmappedLine[] = [];
  for (const m of parsed.data.Medical_List_Information ?? []) {
    // Perform_Calendar は、算定した日に 1 を並べた 31 文字（2 日だけなら 0100…）
    const dates = [...m.Perform_Calendar].flatMap((c, i) => (c === "1" ? [`${query.yearMonth}-${String(i + 1).padStart(2, "0")}`] : []));
    if (dates.length === 0) continue;
    const kubun = codeMap.get(m.Medication_Code);
    if (kubun === undefined || !Object.hasOwn(points, kubun)) unmapped.push({ claimId: query.claimId, code: m.Medication_Code, dates });
    else lines.push({ kubun, count: dates.length, dates });
  }
  return { lines, unmapped };
}
