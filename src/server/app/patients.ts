// 患者マスタ（患者と、保険・公費の加入情報）と、患者ごとに確かめた情報（履歴を残し、項目ごとに最新の 1 件を使う）。
// 患者情報チェック（P01〜P08）もここから呼ぶ。氏名・番号・生年月日は、例外の文言とログに出さない
import { checkPatient, type PatientFinding } from "../../patient/checks";
import { isExpired, validatePatientFact, type PatientFact, type PatientFactInput } from "../../patient/facts";
import { BURDEN_RATIOS, COVERAGE_SOURCES, factsFromPatient, recordOfUke, toHalfWidth, type Coverage, type CoverageInfo, type CoverageSource, type PatientProfile, type PatientRecord } from "../../patient/profile";
import { patientFindingText } from "../../messages";
import type { UkePatient, UkeReceipt } from "../../uke/types";
import { targetOfNeed } from "../../engine";
import type { NeedKey } from "../../engine/types";
import { badRequest, forbidden, notFound } from "../errors";
import type { Role } from "../roles";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Uke } from "./uke";

/** 加入情報の確認入力。番号・負担割合は、渡さなければ今の値のまま。有効期間の終わりの null は「期限の定めなし」 */
export type CoverageInput = {
  coverageId: string;
  source: CoverageSource;
  payerNumber?: string;
  memberNo?: string;
  burdenRatio?: number;
  validFrom?: string | null;
  validUntil?: string | null;
};

type PatientRow = { id: string; name: string | null; sex: number | null; birth: string | null };
type CoverageRow = {
  coverage_id: string;
  patient_id: string;
  kind: string;
  position: number;
  payer_number: string;
  symbol: string;
  member_no: string;
  burden_ratio: number | null;
  valid_from: string | null;
  valid_until: string | null;
  source: string;
  checked_by: string | null;
  checked_at: string | null;
};

/** 氏名の比べ方：空白（全角を含む）を除いて比べる */
const nameKey = (name: string | null) => (name ?? "").replace(/\s/g, "");

export function createPatients(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke) {
  const { sqlite } = ctx;
  const { now } = clock;
  const { clerk } = clerks;
  const { ukeFiles } = uke;

  function receiptOf(claimId: string): UkeReceipt {
    const r = ukeFiles().flatMap((f) => f.receipts).find((x) => x.claimId === claimId);
    if (!r) throw notFound(`UKE にないレセプト: ${claimId}`);
    return r;
  }

  // -------------------------------------------------------------------------
  // 患者マスタ

  /** 加入情報（coverage_id ごとに最新の 1 行） */
  function coveragesOf(patientId: string): Coverage[] {
    const rows = sqlite
      .prepare("SELECT * FROM patient_coverages WHERE id IN (SELECT MAX(id) FROM patient_coverages WHERE patient_id = ? GROUP BY coverage_id) ORDER BY position, id")
      .all(patientId) as CoverageRow[];
    return rows.map((r) => ({
      coverageId: r.coverage_id,
      kind: r.kind as Coverage["kind"],
      position: r.position,
      payerNumber: r.payer_number,
      symbol: r.symbol,
      memberNo: r.member_no,
      burdenRatio: r.burden_ratio,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      source: r.source,
      checkedBy: r.checked_by,
      checkedAt: r.checked_at,
    }));
  }

  /** 新しい加入情報を 1 件足す（coverage_id は最初の行の番号から作る） */
  function addCoverage(patientId: string, c: CoverageInfo, position: number, source: string) {
    const info = sqlite
      .prepare("INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, symbol, member_no, burden_ratio, valid_from, valid_until, source, created_at) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, c.kind, position, c.payerNumber, c.symbol, c.memberNo, c.burdenRatio, c.validFrom, c.validUntil, source, now());
    sqlite.prepare("UPDATE patient_coverages SET coverage_id = 'C' || id WHERE id = ?").run(info.lastInsertRowid);
  }

  /**
   * 患者 1 人分（UKE から、または連携のコネクタから）を患者マスタに取り込み、患者 id を返す。同じ人を二重に作らない鍵は次の順：
   * ① 医保の保険者番号と番号が、その人の加入情報の履歴のどれかと同じで、生年月日と性別も同じ（移行で作った氏名のない患者は番号だけで同じ人とみなす）
   * ② 氏名（空白を除く）・生年月日・性別が同じ（保険が変わっても同じ人として続く）
   * どちらにも当たらなければ新しい患者を作る。加入情報は、履歴にない番号のものだけを足す（確かめて直した番号を、読み直しで増やさない）。
   * 記号・番号は、ここで半角にそろえてから比べ、入れる。
   * すでにある加入情報に、出所が負担割合・有効期間を持ってきたときは、医療事務がまだ確かめていない行に限って履歴に 1 行足す（確かめた記録は上書きしない）
   */
  /** 番号を半角にそろえた記録 */
  const normalized = (record: PatientRecord): PatientRecord => ({ ...record, coverages: record.coverages.map((c) => ({ ...c, payerNumber: toHalfWidth(c.payerNumber), symbol: toHalfWidth(c.symbol), memberNo: toHalfWidth(c.memberNo) })) });
  /** 患者マスタにある同じ患者（医保の番号で探し、なければ生年月日・性別・氏名で探す）。書き込まない */
  function findRow(p: PatientRecord): PatientRow | undefined {
    const medical = p.coverages.find((c) => c.kind === "医保");
    const byNumber = medical
      ? (sqlite
          .prepare("SELECT DISTINCT p.id, p.name, p.sex, p.birth FROM patient_coverages c JOIN patients p ON p.id = c.patient_id WHERE c.kind = '医保' AND c.payer_number = ? AND c.member_no = ? ORDER BY p.id")
          .all(medical.payerNumber, medical.memberNo) as PatientRow[])
      : [];
    const hit = byNumber.find((x) => x.name === null || (x.birth === p.birth && x.sex === p.sex));
    if (hit) return hit;
    const sameBirth = sqlite.prepare("SELECT id, name, sex, birth FROM patients WHERE birth = ? AND sex IS ? ORDER BY id").all(p.birth, p.sex) as PatientRow[];
    return sameBirth.find((x) => nameKey(x.name) !== "" && nameKey(x.name) === nameKey(p.name));
  }
  /** UKE の患者が患者マスタにあれば、その id（なければ null。取り込まない。注14 の計算の道具の下書きが使う） */
  const existingIdOf = (p: UkePatient): string | null => findRow(normalized(recordOfUke(p)))?.id ?? null;

  function ingestRecord(record: PatientRecord, source: string): string {
    const p = normalized(record);
    const find = () => findRow(p);
    const known = sqlite.prepare("SELECT coverage_id FROM patient_coverages WHERE patient_id = ? AND kind = ? AND payer_number = ? AND member_no = ? LIMIT 1");
    const isKnown = (id: string, c: CoverageInfo) => known.get(id, c.kind, c.payerNumber, c.memberNo) as { coverage_id: string } | undefined;
    /** 負担割合・有効期間を持たない出所（UKE）か */
    const plain = p.coverages.every((c) => c.burdenRatio === null && c.validFrom === null && c.validUntil === null);
    // すでに取り込んである患者は、読むだけで返す（画面を開くたびに書き込みのロックを取らない）
    const seen = find();
    if (plain && seen && seen.name !== null && p.coverages.every((c) => isKnown(seen.id, c))) return seen.id;
    return sqlite
      .transaction(() => {
        const found = find();
        let id: string;
        if (!found) {
          // 番号は、いまある番号の最大の次（件数から振ると、患者を消したあとで既存の id とぶつかる）
          const n = (sqlite.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM patients WHERE id GLOB 'P[0-9]*'").get() as { n: number }).n + 1;
          id = `P${String(n).padStart(4, "0")}`;
          sqlite.prepare("INSERT INTO patients (id, name, sex, birth, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, p.name, p.sex, p.birth, source, now());
        } else {
          id = found.id;
          // 移行で作った患者（氏名なし）は、最初に読んだ記録で埋める
          if (found.name === null) sqlite.prepare("UPDATE patients SET name = ?, sex = ?, birth = ?, source = ?, updated_at = ? WHERE id = ?").run(p.name, p.sex, p.birth, source, now(), id);
        }
        let kohi = 0;
        for (const c of p.coverages) {
          const position = c.kind === "医保" ? 0 : ++kohi;
          const hit = isKnown(id, c);
          if (!hit) {
            addCoverage(id, c, position, source);
            continue;
          }
          const cur = coveragesOf(id).find((x) => x.coverageId === hit.coverage_id);
          if (!cur || cur.checkedAt) continue;
          const next = { burdenRatio: c.burdenRatio ?? cur.burdenRatio, validFrom: c.validFrom ?? cur.validFrom, validUntil: c.validUntil ?? cur.validUntil };
          if (next.burdenRatio === cur.burdenRatio && next.validFrom === cur.validFrom && next.validUntil === cur.validUntil) continue;
          sqlite
            .prepare("INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, symbol, member_no, burden_ratio, valid_from, valid_until, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(cur.coverageId, id, cur.kind, cur.position, cur.payerNumber, cur.symbol, cur.memberNo, next.burdenRatio, next.validFrom, next.validUntil, source, now());
        }
        return id;
      })
      .immediate();
  }
  /** UKE の患者を患者マスタに取り込む */
  const ingest = (p: UkePatient): string => ingestRecord(recordOfUke(p), "UKE");

  /** 請求の患者の id（UKE を読んだときに患者マスタへ取り込む） */
  const patientIdOf = (claimId: string): string => ingest(receiptOf(claimId).patient);

  // -------------------------------------------------------------------------
  // 確かめた患者情報（FR-67）

  function latestPatientFacts(patientId: string): PatientFact[] {
    const rows = sqlite
      .prepare("SELECT * FROM patient_facts WHERE id IN (SELECT MAX(id) FROM patient_facts WHERE patient_id = ? GROUP BY fact_key) ORDER BY id")
      .all(patientId) as { patient_id: string; fact_key: string; value: string; source: string; valid_until: string | null; checked_at: string; checked_by: string }[];
    return rows.map((r) => ({
      patientId: r.patient_id,
      key: r.fact_key as PatientFact["key"],
      value: JSON.parse(r.value) as PatientFact["value"],
      source: r.source as PatientFact["source"],
      validUntil: r.valid_until,
      checkedAt: r.checked_at,
      checkedBy: r.checked_by,
    }));
  }
  /** 人数の区分の全部の行（古い順。「いつの診療月から」で選ぶので、最新の 1 行だけでは足りない。design.md §15-4） */
  function buildingBandRows(patientId: string): Pick<PatientFact, "key" | "value">[] {
    return (sqlite.prepare("SELECT value FROM patient_facts WHERE patient_id = ? AND fact_key = 'buildingBand' ORDER BY id").all(patientId) as { value: string }[]).map((r) => ({ key: "buildingBand", value: JSON.parse(r.value) as PatientFact["value"] }));
  }
  /** 要介護・要支援の認定の全部の行（careCert と今までの careLevel。古い順。月の途中で区分が変わったときの 2 行と、始まりの日で選ぶので、最新の 1 行だけでは足りない。design.md §18-1） */
  function careRows(patientId: string): PatientFact[] {
    const rows = sqlite.prepare("SELECT * FROM patient_facts WHERE patient_id = ? AND fact_key IN ('careCert', 'careLevel') ORDER BY id").all(patientId) as { patient_id: string; fact_key: string; value: string; source: string; valid_until: string | null; checked_at: string; checked_by: string }[];
    return rows.map((r) => ({ patientId: r.patient_id, key: r.fact_key as PatientFact["key"], value: JSON.parse(r.value) as PatientFact["value"], source: r.source as PatientFact["source"], validUntil: r.valid_until, checkedAt: r.checked_at, checkedBy: r.checked_by }));
  }
  function patientFacts(claimId: string) {
    const patientId = patientIdOf(claimId);
    return { patientId, facts: latestPatientFacts(patientId).map((f) => ({ ...f, expired: isExpired(f, now()) })) };
  }
  /** role を渡すと宛先を守る：医師の役割が残せるのは、医師あての項目（別表第七など。エンジンの宛先の表）だけ。医療事務は、今までどおりどの項目も残せる（医師あての項目は「医師に確認」を根拠に） */
  function savePatientFact(claimId: string, clerkId: string, f: PatientFactInput, role?: Role) {
    clerk(clerkId);
    if (role === "doctor" && targetOfNeed(f.key as NeedKey) !== "doctor") throw forbidden("これは医療事務が確かめる項目です。事務・ベテランの役割で残します");
    // 入力の検査で落ちたものは、利用者に文言を返す（検査は src/patient/facts.ts）
    try {
      validatePatientFact(f, now());
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    const patientId = patientIdOf(claimId);
    sqlite
      .prepare("INSERT INTO patient_facts (patient_id, fact_key, value, source, valid_until, checked_at, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, f.key, JSON.stringify(f.value), f.source, f.validUntil, now(), clerkId);
    return patientFacts(claimId);
  }

  // -------------------------------------------------------------------------
  // プロフィールと患者情報チェック（FR-116〜123）

  /** 患者マスタのプロフィール（receiptType は請求から渡す） */
  function profileOfPatient(patientId: string, receiptType: string | null = null): PatientProfile {
    const p = sqlite.prepare("SELECT id, name, sex, birth FROM patients WHERE id = ?").get(patientId) as PatientRow | undefined;
    if (!p) throw notFound("患者マスタにない患者");
    // 要介護認定の期限（P07）：最後に残した認定の行。認定なし・分からないの行は期限を持たないので、出さない（design.md §18-1）
    const care = careRows(patientId).at(-1);
    const dated = care && !(care.key === "careCert" && ["認定なし", "分からない"].includes((care.value as { kind: string }).kind));
    return { patientId, name: p.name, sex: p.sex, birth: p.birth, coverages: coveragesOf(patientId), careCertification: care && dated ? { validUntil: care.validUntil } : null, receiptType };
  }

  /** その患者について、エンジンの Facts の年齢・保険種別・負担割合を患者マスタから出す（design.md §6） */
  const masterFacts = (patientId: string, yearMonth: string) => factsFromPatient(profileOfPatient(patientId), yearMonth);

  /**
   * 画面に返す形：加入情報と、患者情報チェックの指摘（文言つき）。氏名・生年月日は返さない（画面のこの欄では使わない）。
   * caseBurdenRatio は症例側が持つ負担割合（なければ null）。患者マスタに負担割合が入っていないときだけ使う
   */
  function patientProfile(claimId: string, caseBurdenRatio: number | null = null) {
    const r = receiptOf(claimId);
    const profile = { ...profileOfPatient(ingest(r.patient), r.patient.receiptType), caseBurdenRatio };
    const serviceDates = [...new Set(r.lines.flatMap((l) => l.dates))].sort();
    return checked(profile, r.yearMonth, serviceDates);
  }
  /** プロフィールを患者情報チェック（P01〜P08）にかけて、画面に返す形にする。UKE から来た患者も、連携から来た患者もここを通る（FR-123） */
  function checked(profile: PatientProfile, yearMonth: string, serviceDates?: string[]) {
    const findings: (PatientFinding & { text: string })[] = checkPatient(profile, { yearMonth, today: now().slice(0, 10), serviceDates }).map((f) => ({ ...f, text: patientFindingText(f) }));
    return { patientId: profile.patientId, yearMonth, coverages: profile.coverages, caseBurdenRatio: profile.caseBurdenRatio ?? null, findings };
  }
  /**
   * 連携のコネクタで読んだ患者基本情報を患者マスタに取り込み、同じ患者情報チェックにかける（FR-123）。
   * 請求を伴わないので、レセプト種別と診療日は見ない（P03・P04 のレセプト種別の照合は出ず、P06 は月の途中の切替を確かめる側に倒れる）
   */
  function checkConnectorPatient(p: PatientRecord, yearMonth: string) {
    return checked(profileOfPatient(ingestRecord(p, "連携")), yearMonth);
  }

  /** 加入情報の確認入力（追記。確かめた人はセッションの本人、時刻はデモの時計） */
  function confirmCoverage(claimId: string, clerkId: string, input: CoverageInput, caseBurdenRatio: number | null = null) {
    clerk(clerkId);
    const patientId = patientIdOf(claimId);
    const cur = coveragesOf(patientId).find((c) => c.coverageId === input.coverageId);
    if (!cur) throw notFound("この患者の加入情報ではありません");
    if (!COVERAGE_SOURCES.includes(input.source)) throw badRequest("確かめた根拠を選んでください");
    if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) throw badRequest("有効期間の始まりが、終わりより後になっています");
    if (input.burdenRatio !== undefined) {
      if (cur.kind !== "医保") throw badRequest("負担割合は医療保険の加入情報に入力します");
      if (!BURDEN_RATIOS.some((b) => b === input.burdenRatio)) throw badRequest("負担割合は 1 割・2 割・3 割から選んでください");
    }
    sqlite
      .prepare(
        "INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, symbol, member_no, burden_ratio, valid_from, valid_until, source, checked_by, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(cur.coverageId, patientId, cur.kind, cur.position, input.payerNumber ?? cur.payerNumber, cur.symbol, input.memberNo ?? cur.memberNo, input.burdenRatio ?? cur.burdenRatio, input.validFrom ?? null, input.validUntil ?? null, input.source, clerkId, now(), now());
    return patientProfile(claimId, caseBurdenRatio);
  }

  return { latestPatientFacts, existingIdOf, buildingBandRows, careRows, patientFacts, savePatientFact, ingest, masterFacts, patientProfile, confirmCoverage, checkConnectorPatient };
}

export type Patients = ReturnType<typeof createPatients>;
