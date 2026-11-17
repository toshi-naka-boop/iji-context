// 患者マスタ（患者と、保険・公費の加入情報）と、患者ごとに確かめた情報（履歴を残し、項目ごとに最新の 1 件を使う）。
// 患者情報チェック（P01〜P08）もここから呼ぶ。氏名・番号・生年月日は、例外の文言とログに出さない
import { checkPatient, type PatientFinding } from "../../patient/checks";
import { isExpired, validatePatientFact, type PatientFact, type PatientFactInput } from "../../patient/facts";
import { BURDEN_RATIOS, COVERAGE_SOURCES, factsFromPatient, type Coverage, type CoverageSource, type PatientProfile } from "../../patient/profile";
import { patientFindingText } from "../../messages";
import type { UkePatient, UkeReceipt } from "../../uke/types";
import { badRequest, notFound } from "../errors";
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
  function addCoverage(patientId: string, kind: Coverage["kind"], position: number, payerNumber: string, symbol: string, memberNo: string) {
    const info = sqlite
      .prepare("INSERT INTO patient_coverages (coverage_id, patient_id, kind, position, payer_number, symbol, member_no, source, created_at) VALUES ('', ?, ?, ?, ?, ?, ?, 'UKE', ?)")
      .run(patientId, kind, position, payerNumber, symbol, memberNo, now());
    sqlite.prepare("UPDATE patient_coverages SET coverage_id = 'C' || id WHERE id = ?").run(info.lastInsertRowid);
  }

  /**
   * UKE の患者を患者マスタに取り込み、患者 id を返す。同じ人を二重に作らない鍵は次の順：
   * ① 医保の保険者番号と番号が、その人の加入情報の履歴のどれかと同じで、生年月日と性別も同じ（移行で作った氏名のない患者は番号だけで同じ人とみなす）
   * ② 氏名（空白を除く）・生年月日・性別が同じ（保険が変わっても同じ人として続く）
   * どちらにも当たらなければ新しい患者を作る。加入情報は、履歴にない番号のものだけを足す（確かめて直した番号を、UKE の読み直しで増やさない）
   */
  function ingest(p: UkePatient): string {
    const find = (): PatientRow | undefined => {
      const byNumber = sqlite
        .prepare("SELECT DISTINCT p.id, p.name, p.sex, p.birth FROM patient_coverages c JOIN patients p ON p.id = c.patient_id WHERE c.kind = '医保' AND c.payer_number = ? AND c.member_no = ? ORDER BY p.id")
        .all(p.insurer.number, p.insurer.no) as PatientRow[];
      const hit = byNumber.find((x) => x.name === null || (x.birth === p.birth && x.sex === p.sex));
      if (hit) return hit;
      const sameBirth = sqlite.prepare("SELECT id, name, sex, birth FROM patients WHERE birth = ? AND sex = ? ORDER BY id").all(p.birth, p.sex) as PatientRow[];
      return sameBirth.find((x) => nameKey(x.name) !== "" && nameKey(x.name) === nameKey(p.name));
    };
    const known = sqlite.prepare("SELECT 1 FROM patient_coverages WHERE patient_id = ? AND kind = ? AND payer_number = ? AND member_no = ? LIMIT 1");
    // すでに取り込んである患者は、読むだけで返す（画面を開くたびに書き込みのロックを取らない）
    const seen = find();
    if (seen && seen.name !== null && known.get(seen.id, "医保", p.insurer.number, p.insurer.no) && p.kohi.every((k) => known.get(seen.id, "公費", k.payerNo, k.recipientNo))) return seen.id;
    return sqlite
      .transaction(() => {
        const found = find();
        let id: string;
        if (!found) {
          const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }).n + 1;
          id = `P${String(n).padStart(4, "0")}`;
          sqlite.prepare("INSERT INTO patients (id, name, sex, birth, source, updated_at) VALUES (?, ?, ?, ?, 'UKE', ?)").run(id, p.name, p.sex, p.birth, now());
        } else {
          id = found.id;
          // 移行で作った患者（氏名なし）は、最初に読んだ UKE で埋める
          if (found.name === null) sqlite.prepare("UPDATE patients SET name = ?, sex = ?, birth = ?, source = 'UKE', updated_at = ? WHERE id = ?").run(p.name, p.sex, p.birth, now(), id);
        }
        if (!known.get(id, "医保", p.insurer.number, p.insurer.no)) addCoverage(id, "医保", 0, p.insurer.number, p.insurer.symbol, p.insurer.no);
        p.kohi.forEach((k, i) => {
          if (!known.get(id, "公費", k.payerNo, k.recipientNo)) addCoverage(id, "公費", i + 1, k.payerNo, "", k.recipientNo);
        });
        return id;
      })
      .immediate();
  }

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
  function patientFacts(claimId: string) {
    const patientId = patientIdOf(claimId);
    return { patientId, facts: latestPatientFacts(patientId).map((f) => ({ ...f, expired: isExpired(f, now()) })) };
  }
  function savePatientFact(claimId: string, clerkId: string, f: PatientFactInput) {
    clerk(clerkId);
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
    const care = latestPatientFacts(patientId).find((f) => f.key === "careLevel");
    return { patientId, name: p.name, sex: p.sex, birth: p.birth, coverages: coveragesOf(patientId), careCertification: care ? { validUntil: care.validUntil } : null, receiptType };
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
    const findings: (PatientFinding & { text: string })[] = checkPatient(profile, { yearMonth: r.yearMonth, today: now().slice(0, 10), serviceDates }).map((f) => ({ ...f, text: patientFindingText(f) }));
    return { patientId: profile.patientId, yearMonth: r.yearMonth, coverages: profile.coverages, caseBurdenRatio, findings };
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

  return { latestPatientFacts, patientFacts, savePatientFact, ingest, masterFacts, patientProfile, confirmCoverage };
}

export type Patients = ReturnType<typeof createPatients>;
