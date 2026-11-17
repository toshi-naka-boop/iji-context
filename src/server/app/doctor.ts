// 医師確認：回答と承認、F3 の代行入力、F4 の照合（病名と処方の不一致）
import { proxyConfirmDraft, type ScribeResult } from "../../mentor/scribe";
import { answerQuery, approveQuery, askMissing, listQueries, validateQuery } from "../../query/doctor-query";
import { crosscheck } from "../../uke/crosscheck";
import type { Cases } from "./cases";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Notes } from "./notes";
import type { Uke } from "./uke";
import { badRequest, conflict, notFound } from "../errors";

export function createDoctor(ctx: AppContext, clock: Clock, uke: Uke, cases: Cases, notes: Notes) {
  const { queryLog } = ctx;
  const { now } = clock;
  const { patientOf } = uke;
  const { caseOf } = cases;
  const { chartOf } = notes;

  const doctorQueries = () => listQueries(queryLog);
  const answerDoctor = (id: string, a: { option: string; freeText?: string; answeredBy: string; answeredById?: string }) => answerQuery(queryLog, id, a, now());
  const approveDoctor = (id: string, approver: string, approverId?: string) => approveQuery(queryLog, id, approver, now(), approverId);

  // -------------------------------------------------------------------------
  // F3 代行入力：整えた文を必ず医師確認に回す（FR-37）。足りない項目は推定せず聞く（FR-36）

  function proxySubmit(claimId: string, original: string, scribed: ScribeResult) {
    caseOf(claimId);
    const draft = proxyConfirmDraft(claimId, original, scribed.text);
    const doctorMissing = scribed.missing.filter((m) => m.target === "doctor");
    if (doctorMissing.length) draft.indicators.push({ source: "記載が足りない項目", text: doctorMissing.map((m) => `${m.field}（${m.why}）`).join("、") });
    // 下書きの言葉が医師確認の要件（点数・金額に触れない、など）に合わないときは、利用者向けの誤りとして先に断る（文言は createQuery のものと同じ）
    const errors = validateQuery(draft);
    if (errors.length) throw badRequest(`医師確認の要件を満たさない: ${errors.join(" / ")}`);
    const r = askMissing(queryLog, { target: "doctor", ...draft }, now());
    const clerkTasks = scribed.missing
      .filter((m) => m.target === "clerk")
      .map((m) => askMissing(queryLog, { target: "clerk", claimId, field: m.field, why: m.why }, now()))
      .map((x) => (x.route === "F3" ? x.task : null))
      .filter((t) => t !== null);
    return { query: r.route === "F1" ? r.query : null, clerkTasks };
  }

  // -------------------------------------------------------------------------
  // F4 の照合（病名と処方の不一致）→ 医師確認

  /** 医師の回答と承認で確定した傷病名（FR-32） */
  function confirmedDiseases(claimId: string): string[] {
    return doctorQueries()
      .filter((q) => q.claimId === claimId && q.status === "承認済み" && q.field.startsWith("SY:") && q.answer)
      .map((q) => (q.answer!.option === "その他" ? q.answer!.freeText ?? "" : q.answer!.option))
      .filter((n) => n && n !== "判定不能");
  }
  /** 確認してほしい点（照合）。同じ項目の医師確認がすでにあれば、その状態も返す */
  function crosscheckOf(claimId: string, asOf?: string, clerkId?: string) {
    const whole = chartOf(claimId, clerkId);
    // 訪問の時点では、その日までのカルテと処方だけで照合する
    const chart = whole && asOf ? { ...whole, entries: whole.entries.filter((e) => e.date <= asOf), prescriptions: whole.prescriptions.filter((p) => p.date <= asOf) } : whole;
    if (!chart) return { mismatches: [], confirmed: confirmedDiseases(claimId) };
    const qs = doctorQueries().filter((q) => q.claimId === claimId);
    return {
      mismatches: crosscheck(patientOf(claimId), chart, confirmedDiseases(claimId)).map((m) => ({ ...m, query: qs.find((q) => q.field === m.draft.field && q.status !== "承認済み") ?? null })),
      confirmed: confirmedDiseases(claimId),
    };
  }
  /** 照合の不一致から医師確認を送る（ask_missing の宛先＝医師） */
  function sendCrosscheck(claimId: string, ruleId: string, asOf?: string, clerkId?: string) {
    const m = crosscheckOf(claimId, asOf, clerkId).mismatches.find((x) => x.ruleId === ruleId);
    if (!m) throw notFound(`不一致がない: ${claimId} ${ruleId}`);
    if (m.query) throw conflict(`医師確認はもう送ってある: ${m.query.id}`);
    return askMissing(queryLog, { target: "doctor", ...m.draft }, now());
  }

  function resolvedFields(claimId: string): string[] {
    return doctorQueries()
      .filter((q) => q.claimId === claimId && q.status === "承認済み")
      .map((q) => q.field.replace(/^fact:/, ""));
  }

  return { doctorQueries, answerDoctor, approveDoctor, proxySubmit, confirmedDiseases, crosscheckOf, sendCrosscheck, resolvedFields };
}

export type Doctor = ReturnType<typeof createDoctor>;
