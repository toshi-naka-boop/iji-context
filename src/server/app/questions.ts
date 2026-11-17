// 処理体験（1 件＝1 問）：問題の保存と進行、選択モード、練習問題
import type { ClaimContext, ClaimLine } from "../../engine/types";
import { submit } from "../../lifecycle/review";
import { choiceItems, judgePick } from "../../practice/choice";
import { doctorDrillList, doctorDrillOf, factQueryDraft, FACT_QUESTIONS, isDoctorDrill } from "../../practice/doctor-drills";
import { drillList, drillOf } from "../../practice/drills";
import { checkDraft, confirm, finish, myStatus, startQuestion, toExplanation, type Mode, type Question } from "../../practice/practice";
import { askMissing } from "../../query/doctor-query";
import { visitDays } from "../../visit/as-of";
import type { Cases } from "./cases";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Doctor } from "./doctor";
import type { Notes } from "./notes";
import type { QuestionCase } from "./question-case";

export function createQuestions(ctx: AppContext, clock: Clock, clerks: Clerks, cases: Cases, notes: Notes, doctor: Doctor, questionCase: QuestionCase) {
  const { sqlite, queryLog, deps, levels, levelCfg, choiceGroups } = ctx;
  const { now } = clock;
  const { clerk } = clerks;
  const { caseOf } = cases;
  const { monthOf } = notes;
  const { crosscheckOf } = doctor;
  const { caseFor, drillQuery, judgeFor, withLines } = questionCase;

  const saveQ = (q: Question) =>
    sqlite.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(q.id, q.clerkId, q.claimId, JSON.stringify(q));
  const loadQ = (id: string): Question => {
    const r = sqlite.prepare("SELECT data FROM questions WHERE id = ?").get(id) as { data: string } | undefined;
    if (!r) throw new Error(`問題がない: ${id}`);
    return JSON.parse(r.data) as Question;
  };
  const allQ = (): Question[] => (sqlite.prepare("SELECT data FROM questions").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Question);

  /** 練習問題を始める（FR-75。答えのルールは本人に見せない） */
  function startDrill(clerkId: string, drillId: string): Question {
    clerk(clerkId);
    const d = isDoctorDrill(drillId) ? doctorDrillOf(drillId) : drillOf(drillId);
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n;
    const q = startQuestion(`q${String(n + 1).padStart(4, "0")}`, clerkId, d.claimId, now(), "通常", undefined, d.id);
    saveQ(q);
    return q;
  }
  function start(clerkId: string, claimId: string, mode: Mode = "通常", asOf?: string): Question {
    clerk(clerkId);
    const c = monthOf(claimId, clerkId);
    if (asOf) {
      if (mode !== "通常") throw new Error("訪問の時点の問題は通常モードだけ");
      if (!visitDays(c).some((d) => d.date === asOf)) throw new Error(`この日の訪問はない: ${claimId} ${asOf}`);
    }
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n;
    const q = startQuestion(`q${String(n + 1).padStart(4, "0")}`, clerkId, claimId, now(), mode, asOf);
    saveQ(q);
    return q;
  }
  function draft(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const r = checkDraft(q, { ...caseFor(q), lines, facts: { ...caseFor(q).facts, ...(facts ?? {}) } }, now(), judgeFor(q));
    saveQ(r.question);
    return r;
  }
  /** 確定：エンジンが判定し、提出として適用記録を書く（ライフサイクルの submit） */
  function confirmQ(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const ctx = { ...caseFor(q), lines, facts: { ...caseFor(q).facts, ...(facts ?? {}) } };
    let next = confirm(q, ctx, now(), judgeFor(q));
    // 医師確認の練習問題は、情報不足が残っている（医師に聞かずに確定した）ときや、照合の不一致が残っているときは不正解（FR-76）
    if (q.drill && isDoctorDrill(q.drill)) {
      const d = doctorDrillOf(q.drill);
      const open = d.crosscheck ? crosscheckOf(q.claimId).mismatches.some((m) => m.ruleId === d.crosscheck) : false;
      next = { ...next, correct: next.confirmed!.result.findings.length === 0 && !open };
    }
    // 訪問の時点の確定と練習問題は提出ではない。適用記録は月末の UKE の問題でだけ書く
    if (q.asOf || q.drill) {
      saveQ(next);
      return next;
    }
    submit(deps, {
      submissionId: id,
      final: { ctx, applied: next.confirmed!.result.applied },
      earlier: q.drafts.map((d) => ({ ctx: withLines(q.claimId, d.lines, facts), applied: [] })),
      now: now(),
    });
    saveQ(next);
    return next;
  }
  function explain(id: string) {
    const q = toExplanation(loadQ(id));
    saveQ(q);
    return q;
  }
  function done(id: string) {
    const q = finish(loadQ(id), now());
    saveQ(q);
    return q;
  }
  // 選択モード：問題は UKE の原案（医療事務が入力した明細）から作り、正誤はユスティだけで決める
  function choiceQ(id: string) {
    const q = loadQ(id);
    if (q.mode !== "選択") throw new Error(`選択モードの問題ではない: ${id}`);
    if (q.phase !== "ヒント") throw new Error(`選べない段階: ${q.phase}`);
    return q;
  }
  const choices = (id: string) => choiceItems(caseOf(choiceQ(id).claimId), choiceGroups);
  function pick(id: string, lineIndex: number, option: string) {
    const q = choiceQ(id);
    const r = judgePick(caseOf(q.claimId), choiceGroups, lineIndex, option);
    saveQ({ ...q, picks: [...(q.picks ?? []), { lineIndex, option, correct: r.correct, at: now() }] });
    return r;
  }
  // 件数・レベル・防いだ額は月末の UKE の問題（提出）だけで数える。訪問の時点の問題は数えない（FR-68）
  const submitted = () => allQ().filter((q) => !q.asOf);
  const status = (clerkId: string) => myStatus(submitted(), clerkId, levels, levelCfg.choiceWeight ?? 1);
  const questionsOf = (clerkId: string) => allQ().filter((q) => q.clerkId === clerkId);

  /** 医師確認の練習問題で、医師に聞く（推測で算定しない）。同じ問題から 2 回は送らない */
  function askDoctorForDrill(questionId: string) {
    const q = loadQ(questionId);
    const d = q.drill && isDoctorDrill(q.drill) ? doctorDrillOf(q.drill) : null;
    if (!d?.ask) throw new Error("この問題では、ここから医師確認は送らない");
    if (q.phase !== "ヒント") throw new Error(`医師確認を送れない段階: ${q.phase}`);
    const existing = drillQuery(q);
    if (existing) return existing;
    const r = askMissing(queryLog, { target: "doctor", ...factQueryDraft(d.ask, caseFor(q), q.id) }, now());
    if (r.route !== "F1") throw new Error("医師確認にならなかった");
    return r.query;
  }
  /** 練習問題の今の状態（画面用）：医師確認の状態、照合の不一致が残っているか */
  function drillState(questionId: string) {
    const q = loadQ(questionId);
    if (!q.drill) return null;
    if (!isDoctorDrill(q.drill)) return { kind: "明細" as const };
    const d = doctorDrillOf(q.drill);
    const a = drillQuery(q);
    return {
      kind: "医師確認" as const,
      ask: d.ask ? FACT_QUESTIONS[d.ask].label : null,
      query: a ? { id: a.id, status: a.status, answer: a.answer?.option ?? null } : null,
      crosscheckOpen: d.crosscheck ? crosscheckOf(q.claimId).mismatches.some((m) => m.ruleId === d.crosscheck) : false,
    };
  }
  /** 練習問題の一覧。cleared は本人がその練習を正解で終えたか（画面のカードの状態に使う。2026-11-08） */
  const drills = (clerkId?: string) => {
    const done = new Set(clerkId ? questionsOf(clerkId).filter((q) => q.drill && q.correct === true).map((q) => q.drill) : []);
    const mark = <T extends { id: string }>(xs: T[]) => xs.map((d) => ({ ...d, cleared: done.has(d.id) }));
    return { fix: mark(drillList()), doctor: mark(doctorDrillList()) };
  };

  return { loadQ, startDrill, start, draft, confirmQ, explain, done, choices, pick, submitted, status, questionsOf, askDoctorForDrill, drillState, drills };
}

export type Questions = ReturnType<typeof createQuestions>;
