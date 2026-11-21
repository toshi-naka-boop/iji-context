// ORCA API 形式（日医標準レセプトソフト API）の読み取りコネクタ（spec FR-110）。読み取りだけで、書き込みの API は呼ばない。
// 相手は同梱の模擬サーバー（fixtures/connect/mock-server.ts）。実機にはつないでいない。
// 持っているのは患者基本情報（PatientSource）と請求（ClaimSource）。請求は診療行為の API（xml2 形式だけ）から読む（下の注）。
// 診療年月の版のコードの表にないコードの行は、断らずに点検の対象外の単位（UkeReceipt.others）として残し、unmapped にも並べる（UKE の取り込みと同じ扱い。FR-111・FR-160。2026-11-21 利用者の判断 U-Y）。
// 対象外の単位があるレセプトは請求の一部しか点検していない（partial）。基本マスターが手元にあれば、点検の側がその行の名称を引き、データで動く点検を掛ける
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { monthRange } from "../demo/period";
import { hasRevision, resolveRevision } from "../engine/revisions";
import { bundleKubun, bundleOfCode, kubunOfCode } from "../engine/revisions/codes";
import type { Bundle } from "../engine/revisions/types";
import type { Payer } from "../engine/types";
import type { CoverageInfo } from "../patient/profile";
import { payerOfInsurer } from "../uke/cases";
import { UKE_CLAIM_ID } from "../uke/limits";
import type { UkeFile, UkeLine, UkeOther } from "../uke/types";
import { connectJson, connectText, ConnectError, formatError } from "./fetch";
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
//   - POST /api01rv2/medicalgetv2?class=03（診療月診療コード情報取得）。「リクエストおよびレスポンスデータは xml2 形式」。
//     Content-Type は application/xml（文字コードは UTF-8）。format=json の記載はない（2026-11-18 に読み直した）
//   - 要求：<data><medicalgetreq type="record"> の下に Patient_ID（必須）・Perform_Date（診療日 YYYY-MM-DD。
//     「診療年月指定時は、日のチェックは行いません」）。InOut は「I：入院」のときだけ書く項目なので、外来（在宅）では書かない
//   - 応答：<xmlio2><medicalget03res type="record"> の下に Api_Result（10＝患者番号に該当する患者が存在しません）・
//     Patient_Information（Patient_ID ほか）・Perform_Date（診療年月 YYYY-MM）・Medical_List_Information（繰り返し 400。
//     type="array" で、1 件は Medical_List_Information_child）。1 件の項目は Medication_Code（コード）・
//     Medical_Class_code（包括区分。1：包括分）・Perform_Total_Number（算定合計数＝算定した日の合計。例 01）・
//     Perform_Calendar（算定日区分。算定した日に 1、それ以外に 0 を並べた 31 文字）
//   患者病名 https://www.orca.med.or.jp/receipt/tec/api/disease.html：POST /api01rv2/diseasegetv2。これも xml2 形式だけ（読んでいない）
//
// 【診療行為の API に載っていないもの】（請求の境界の型 UkeFile のうち、このコネクタが埋められない項目）
//   - 同じ日に 2 回以上の算定（算定日区分は日ごとの 0／1 だけ）。回数は「算定した日の数」として読む
//   - 点数・回数の算定単位。包括の検査（項目数で区分が決まる）は、算定日区分が同じ項目をひとまとまりとして数える
//   - どの保険で請求したか。保険は患者基本情報から引き、医療保険が 1 つに決まらなければ受け取らない。公費は患者基本情報にあるものを全部載せる
//   - レセプト種別・傷病名・コメント・医療機関の情報・都道府県・請求年月。空で返す（レセプト種別と傷病名を使うチェックは働かない。コメントは「持たない」として返す）
//   - 請求 id。患者番号と診療年月から「患者番号-診療年月」で作る
//
// 【公式仕様で未確認。実機につなぐ前に確認する】
//   - format=json のときの JSON の形（最上位のキーが patientinfores のままか、xml2 の「〜_child」の繰り返しが配列になるか）。
//     仕様ページにあるのは xml2 のサンプルだけ。下のスキーマは「同じ項目名で、繰り返しは配列」と仮定している
//   - 記号・番号が全角で返るか（仕様の例は全角。このコネクタは返ったまま写す）
//   - 適用終了日 9999-12-31 の意味（仕様の例に出る。期限なしと読めるが明記はない。返ったまま写す）
//   - 公費の Rate_Outpatient（「外来ー負担率(割)」）の単位。未確認のため写していない
//   - 診療行為：要求の Perform_Date に診療年月だけ（YYYY-MM）を書けるか（このコネクタは月の初日を送る）。応答の content-type
//     （application/xml と仮定）と XML 宣言の有無。その月に診療行為がないときの応答（エラー一覧に「15 対象がありません」があるが、
//     class=03 で返るかは書かれていない。このコネクタは 15 を相手の失敗として扱う）。包括分の行の扱い（受け取らない）。
//     患者番号が頭にゼロを足して返るか（仕様の例は 00017。このコネクタは頼んだ番号と同じでなければ受け取らない）
// ───────────────────────────────────────────────────────────────────────────
export const ORCA_WIRE = {
  patientPath: "api01rv2/patientgetv2",
  patientRoot: "patientinfores",
  /** 「患者番号に該当する患者が存在しません」（患者基本情報・診療行為で同じ） */
  notFoundResult: "10",
  medicalPath: "api01rv2/medicalgetv2",
  /** 診療月診療コード情報取得 */
  medicalClass: "03",
  medicalRequestRoot: "medicalgetreq",
  xmlRoot: "xmlio2",
  medicalRoot: "medicalget03res",
  xmlType: "application/xml",
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

/** 診療月診療コード情報の 1 件（項目名は公式仕様のもの。上の注） */
const OrcaMedicalRow = z.object({
  Medication_Code: z.string().regex(/^\d{9}$/),
  Medical_Class_code: z.string().max(4).optional(),
  Perform_Total_Number: z.string().regex(/^\d{1,2}$/).optional(),
  Perform_Calendar: z.string().regex(/^[01]{31}$/),
});

/** 診療行為（class=03）の応答。xml2 形式を読んだあとの形（値はすべて文字列。繰り返しは「〜_child」の配列） */
export const OrcaMedicalResponse = z.object({
  [ORCA_WIRE.xmlRoot]: z.object({
    [ORCA_WIRE.medicalRoot]: z.object({
      Api_Result: z.string().regex(/^[0-9A-Za-z]{1,4}$/),
      Patient_Information: z.object({ Patient_ID: z.string() }).optional(),
      Perform_Date: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      Medical_List_Information: z.object({ Medical_List_Information_child: z.array(OrcaMedicalRow).max(400) }).optional(),
    }),
  }),
});

// xml2 形式の読み取り。安全な側に倒す：値は文字列のまま（数にしない）、属性（type="string" など）は読まない、実体は展開しない。
// Object.prototype にある名前（__proto__・constructor・toString など）の要素は、パーサが例外にする（読んだ結果に載せない）
const xml2 = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: false,
  isArray: (name) => name.endsWith("_child"),
  onDangerousProperty: () => {
    throw new Error("reserved name");
  },
});

/** 応答の本文（大きさの上限は connectText で通してある）を xml2 形式として読む。読めなければ形式違い（本文は出さない） */
function parseXml2(what: string, text: string): unknown {
  // DOCTYPE（実体の宣言・外部実体）のある応答は、読まずに断る
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ConnectError(ORCA_ID, "format", `${what}に DOCTYPE・実体の宣言がある（受け取らない）`);
  try {
    // パーサは閉じていないタグを読み飛ばすので、先に整形式かを確かめる
    if (XMLValidator.validate(text) === true) return xml2.parse(text);
  } catch {
    // 下の形式違いにする
  }
  throw new ConnectError(ORCA_ID, "format", `${what}が XML として読めない`);
}

/** 診療行為の応答を算定行にする。受け取れない行が 1 つでもあれば、応答ごと断る（一部だけを読んで返さない） */
/** 診療行為の応答を、算定行と、点検の対象外の単位（版の表にないコードの行。1 行で 1 単位）に分ける */
function toLines(patientId: string, yearMonth: string, raw: unknown): { lines: UkeLine[]; others: UkeOther[] } {
  const parsed = OrcaMedicalResponse.safeParse(raw);
  if (!parsed.success) throw formatError(ORCA_ID, "診療行為", parsed.error.issues);
  const res = parsed.data[ORCA_WIRE.xmlRoot][ORCA_WIRE.medicalRoot];
  if (res.Api_Result === ORCA_WIRE.notFoundResult) throw new ConnectError(ORCA_ID, "not_found", "患者が見つからない");
  if (!isOk(res.Api_Result)) throw new ConnectError(ORCA_ID, "upstream", `相手が失敗の結果を返した（Api_Result ${res.Api_Result}）`);
  if (res.Patient_Information?.Patient_ID !== patientId) throw new ConnectError(ORCA_ID, "format", "頼んだ患者と違う患者の応答が返った");
  if (res.Perform_Date !== yearMonth) throw new ConnectError(ORCA_ID, "format", "頼んだ診療年月と違う月の応答が返った");
  const refuse = (reason: string) => new ConnectError(ORCA_ID, "format", `診療行為を受け取れない（${reason}）`);
  // コードは、診療年月の版の表で区分に引く（版を決めてから引く。UKE の取り込みと同じ表）
  const rev = resolveRevision(yearMonth);
  const daysInMonth = Number(monthRange(yearMonth).end.slice(8));
  /** 包括の検査の項目：同じ包括・同じ算定日区分の行をひとまとまりにし、項目数で区分を決める */
  const bundled = new Map<string, { bundle: Bundle; line: UkeLine & { items: string[] } }>();
  const lines: UkeLine[] = [];
  const others: UkeOther[] = [];
  for (const [index, m] of (res.Medical_List_Information?.Medical_List_Information_child ?? []).entries()) {
    const kubun = kubunOfCode(rev, m.Medication_Code);
    const bundle = bundleOfCode(rev, m.Medication_Code);
    // 包括分（別に算定しない行）を算定行に数えない。どう返るかが未確認なので、あれば断る
    if (m.Medical_Class_code === "1") throw refuse("包括分の行には未対応");
    if (m.Perform_Calendar.slice(daysInMonth).includes("1")) throw refuse("診療年月にない日に算定がある");
    const dates = [...m.Perform_Calendar].flatMap((c, i) => (c === "1" ? [`${yearMonth}-${String(i + 1).padStart(2, "0")}`] : []));
    if (dates.length === 0 || (m.Perform_Total_Number !== undefined && Number(m.Perform_Total_Number) !== dates.length)) throw refuse("算定日と算定合計数が合わない");
    // 版の表にないコード：形の検査（上）を通したうえで、点検の対象外の単位として残す。点数は診療行為の API に載らないので持たない
    if (kubun === null && bundle === null) {
      others.push({ unit: index, codes: [m.Medication_Code], points: null, count: dates.length, days: [...m.Perform_Calendar].map((c) => (c === "1" ? 1 : 0)) });
      continue;
    }
    if (kubun !== null) {
      lines.push({ kubun, count: dates.length, dates });
      continue;
    }
    const key = `${rev.bundles.indexOf(bundle!)}/${m.Perform_Calendar}`;
    const group = bundled.get(key);
    if (group?.line.items.includes(m.Medication_Code)) throw refuse("包括の検査の同じ項目が 2 つある");
    if (group) group.line.items.push(m.Medication_Code);
    else {
      // 区分は、全部の行を読んでから項目数で決める（並びは最初の項目の位置）
      const line = { kubun: "", count: dates.length, dates, items: [m.Medication_Code] };
      bundled.set(key, { bundle: bundle!, line });
      lines.push(line);
    }
  }
  for (const { bundle, line } of bundled.values()) {
    const kubun = bundleKubun(bundle, line.items.length);
    if (kubun === null) throw refuse("包括の検査の項目数が、算定できる数に足りない");
    line.kubun = kubun;
  }
  return { lines, others };
}

export function createOrcaConnector(): Connector {
  const getPatient = async (patientId: string): Promise<ConnectorPatient> => {
    assertQuery(patientId, null);
    const raw = await connectJson(ORCA_ID, `${ORCA_WIRE.patientPath}?id=${encodeURIComponent(patientId)}&format=json`);
    return toPatient(patientId, raw);
  };
  return {
    id: ORCA_ID,
    label: "ORCA API 形式（読み取り・患者基本情報と請求）",
    patient: { getPatient },
    claims: {
      async getClaims({ yearMonth, patientIds }) {
        assertQuery(null, yearMonth);
        // 診療行為の API は患者ごと。請求 id は「患者番号-診療年月」で作る（UKE の請求 id と同じ文字種・長さに収まること）
        if (!patientIds?.length) throw new Error("患者の id を指定する（ORCA 形式は患者ごとに読む）");
        for (const id of patientIds) {
          assertQuery(id, null);
          if (!UKE_CLAIM_ID.test(`${id}-${yearMonth}`)) throw new Error("患者の id が長すぎて、請求 id にできない");
        }
        // 該当する版がない診療年月は読まない（近い版で代用しない）
        if (!hasRevision(yearMonth)) throw new ConnectError(ORCA_ID, "format", "診療年月に当たる版がない");
        const files = new Map<Payer, UkeFile>();
        const unmapped: UnmappedLine[] = [];
        for (const patientId of patientIds) {
          const body = `<data><${ORCA_WIRE.medicalRequestRoot} type="record"><Patient_ID type="string">${patientId}</Patient_ID><Perform_Date type="string">${monthRange(yearMonth).start}</Perform_Date></${ORCA_WIRE.medicalRequestRoot}></data>`;
          const text = await connectText(ORCA_ID, `${ORCA_WIRE.medicalPath}?class=${ORCA_WIRE.medicalClass}`, { method: "POST", body, contentType: ORCA_WIRE.xmlType, accept: [ORCA_WIRE.xmlType] });
          const { lines, others } = toLines(patientId, yearMonth, parseXml2("診療行為", text));
          if (lines.length === 0 && others.length === 0) continue;
          // 保険は診療行為の応答に載らないので、患者基本情報から引く。医療保険が 1 つに決まらなければ、あて先（審査支払機関）を決めない
          const p = await getPatient(patientId);
          const medical = p.coverages.filter((c) => c.kind === "医保");
          if (medical.length !== 1) throw new ConnectError(ORCA_ID, "format", "医療保険が 1 つに決まらず、審査支払機関を決められない");
          const payer = payerOfInsurer(medical[0].payerNumber);
          // 性別は患者基本情報の応答の検査（Sex は 1 か 2）で決まっているが、型の上では null があり得るので、ここでも確かめる（UKE のレセプトは性別を欠かせない）
          if (p.sex === null) throw new ConnectError(ORCA_ID, "format", "性別が読めない");
          // 医療機関の情報・都道府県・請求年月・レセプト種別・傷病名・コメントは、診療行為の API に載っていない（上の注）
          const file = files.get(payer) ?? { payer, prefecture: "", clinic: { code: "", name: "", phone: "" }, billingMonth: "", receipts: [] };
          files.set(payer, file);
          file.receipts.push({
            claimId: `${patientId}-${yearMonth}`,
            yearMonth,
            patient: {
              name: p.name,
              sex: p.sex,
              birth: p.birth,
              receiptType: "",
              insurer: { number: medical[0].payerNumber, symbol: medical[0].symbol, no: medical[0].memberNo },
              kohi: p.coverages.filter((c) => c.kind === "公費").map((c) => ({ payerNo: c.payerNumber, recipientNo: c.memberNo })),
              diseases: [],
            },
            lines,
            ...(others.length > 0 ? { others } : {}),
            comments: [],
            commentsKnown: false,
          });
          for (const o of others) unmapped.push({ claimId: `${patientId}-${yearMonth}`, code: o.codes[0], dates: o.days.flatMap((n, i) => (n > 0 ? [`${yearMonth}-${String(i + 1).padStart(2, "0")}`] : [])) });
        }
        return { files: [...files.values()], unmapped };
      },
    },
  };
}
