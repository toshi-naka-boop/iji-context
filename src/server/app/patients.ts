// 患者ごとに確かめた情報（履歴を残し、項目ごとに最新の 1 件を使う）
import { isExpired, patientKeyOf, validatePatientFact, type PatientFact, type PatientFactInput } from "../../patient/facts";
import { badRequest } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Uke } from "./uke";

export function createPatients(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke) {
  const { sqlite } = ctx;
  const { now } = clock;
  const { clerk } = clerks;
  const { patientOf } = uke;

  function latestPatientFacts(patientKey: string): PatientFact[] {
    const rows = sqlite
      .prepare("SELECT * FROM patient_facts WHERE id IN (SELECT MAX(id) FROM patient_facts WHERE patient_key = ? GROUP BY fact_key) ORDER BY id")
      .all(patientKey) as { patient_key: string; fact_key: string; value: string; source: string; valid_until: string | null; checked_at: string; checked_by: string }[];
    return rows.map((r) => ({
      patientKey: r.patient_key,
      key: r.fact_key as PatientFact["key"],
      value: JSON.parse(r.value) as PatientFact["value"],
      source: r.source as PatientFact["source"],
      validUntil: r.valid_until,
      checkedAt: r.checked_at,
      checkedBy: r.checked_by,
    }));
  }
  function patientFacts(claimId: string) {
    const patientKey = patientKeyOf(patientOf(claimId));
    return { patientKey, facts: latestPatientFacts(patientKey).map((f) => ({ ...f, expired: isExpired(f, now()) })) };
  }
  function savePatientFact(claimId: string, clerkId: string, f: PatientFactInput) {
    clerk(clerkId);
    // 入力の検査で落ちたものは、利用者に文言を返す（検査は src/patient/facts.ts）
    try {
      validatePatientFact(f, now());
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    const patientKey = patientKeyOf(patientOf(claimId));
    sqlite
      .prepare("INSERT INTO patient_facts (patient_key, fact_key, value, source, valid_until, checked_at, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(patientKey, f.key, JSON.stringify(f.value), f.source, f.validUntil, now(), clerkId);
    return patientFacts(claimId);
  }

  return { latestPatientFacts, patientFacts, savePatientFact };
}

export type Patients = ReturnType<typeof createPatients>;
