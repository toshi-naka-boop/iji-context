// 処理体験（1 件＝1 問）：問題の保存と進行、選択モード、練習問題
import { resolveRevision } from "../../engine/revisions";
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
import { declarationViewOf } from "./facility";
import { genericOfLines } from "./generic";
import type { LocalAbout } from "./local-pairs";
import type { Notes } from "./notes";
import type { QuestionCase } from "./question-case";
import { badRequest, conflict, notFound } from "../errors";

/** 実在のデータで使うクリニックで、練習問題を出さない理由（画面に出す） */
const REAL_NO_DRILLS = "練習問題は、デモのクリニックだけで使えます（同梱の作り物の症例で始めるため）";

/** reviewedCount は、問題のほかに処理件数へ足す件数（実在用のクリニックで点検を確かめた請求。src/server/app/claim-reviews.ts）。渡さなければ 0 */
export function createQuestions(ctx: AppContext, clock: Clock, clerks: Clerks, cases: Cases, notes: Notes, doctor: Doctor, questionCase: QuestionCase, reviewedCount: (clerkId: string) => number = () => 0) {
  const { sqlite, queryLog, deps, levels, levelCfg, choiceGroups, hiddenClaim } = ctx;
  const { now } = clock;
  const { clerk } = clerks;
  const { isUploaded } = cases;
  const { monthOf } = notes;
  const { crosscheckOf } = doctor;
  const { caseFor, drillQuery, judgeFor, withLines } = questionCase;

  const saveQ = (q: Question) =>
    sqlite.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(q.id, q.clerkId, q.claimId, JSON.stringify(q));
  /**
   * 新しい問題を保存する。番号は、いまある番号の最大の次（件数から振ると、行が消えたときに既存の id とぶつかる）。
   * 採番と保存は 1 つのトランザクションにして、既存の行は上書きしない（ぶつかったら主キーの違反で止まる）
   */
  const createQ = sqlite.transaction((make: (id: string) => Question): Question => {
    const n = (sqlite.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM questions WHERE id GLOB 'q[0-9]*'").get() as { n: number }).n;
    const q = make(`q${String(n + 1).padStart(4, "0")}`);
    sqlite.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?)").run(q.id, q.clerkId, q.claimId, JSON.stringify(q));
    return q;
  });
  const loadQ = (id: string): Question => {
    const r = sqlite.prepare("SELECT data FROM questions WHERE id = ?").get(id) as { data: string } | undefined;
    if (!r) throw notFound(`問題がない: ${id}`);
    return JSON.parse(r.data) as Question;
  };
  /** いまの段階ではできない操作は、業務上の拒否として文言を返す（文言は src/practice/practice.ts と同じ） */
  const inPhase = (q: Question, phase: Question["phase"], what: string) => {
    if (q.phase !== phase) throw conflict(`${what}: ${q.phase}`);
  };
  /** 明細の区分は点数表にあるものだけ。ない区分は、判定に渡す前に利用者向けの誤りとして断る（文言はエンジンの pointsOf と同じ）。点数表は請求の診療年月の版 */
  const checkLines = (lines: ClaimLine[], yearMonth: string) => {
    const points = resolveRevision(yearMonth).points;
    const bad = lines.find((l) => !Object.hasOwn(points, l.kubun));
    if (bad) throw badRequest(`未知の区分: ${bad.kubun}`);
  };
  // 見本の請求の問題は、demo 以外のクリニックでは一覧・集計に出さない（行は残す）
  const allQ = (): Question[] => (sqlite.prepare("SELECT data FROM questions").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Question).filter((q) => !hiddenClaim(q.claimId));

  /** 練習問題を始める（FR-75。答えのルールは本人に見せない） */
  function startDrill(clerkId: string, drillId: string): Question {
    clerk(clerkId);
    // 練習問題は同梱の症例（作り物）で始める。実在のデータで使うクリニックには症例がないので、使えない
    if (ctx.kind !== "demo") throw badRequest(REAL_NO_DRILLS);
    if (!isDoctorDrill(drillId) && !drillList().some((x) => x.id === drillId)) throw notFound(`練習問題がない: ${drillId}`);
    const d = isDoctorDrill(drillId) ? doctorDrillOf(drillId) : drillOf(drillId);
    return createQ.immediate((id) => startQuestion(id, clerkId, d.claimId, now(), "通常", undefined, d.id));
  }
  function start(clerkId: string, claimId: string, mode: Mode = "通常", asOf?: string): Question {
    clerk(clerkId);
    const c = monthOf(claimId, clerkId);
    // 選択モードの正解は、カルテ側の記録を読むルールも使って 1 つに決める。記録のないレセプトでは決められないので、対象外にする
    if (mode === "選択" && isUploaded(claimId)) throw badRequest("アップロードした UKE のレセプトは、選択モードの対象外です（カルテ側の記録がなく、正解を 1 つに決められないため）。通常モードで点検してください");
    if (asOf) {
      if (mode !== "通常") throw badRequest("訪問の時点の問題は通常モードだけ");
      if (!visitDays(c).some((d) => d.date === asOf)) throw notFound(`この日の訪問はない: ${claimId} ${asOf}`);
    }
    return createQ.immediate((id) => startQuestion(id, clerkId, claimId, now(), mode, asOf));
  }
  function draft(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    inPhase(q, "ヒント", "下書きを確かめられない段階");
    checkLines(lines, caseFor(q).yearMonth);
    const r = checkDraft(q, { ...caseFor(q), lines, facts: { ...caseFor(q).facts, ...(facts ?? {}) } }, now(), judgeFor(q));
    saveQ(r.question);
    return r;
  }
  /** 確定：エンジンが判定し、提出として適用記録を書く（ライフサイクルの submit） */
  function confirmQ(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    inPhase(q, "ヒント", "確定できない段階");
    checkLines(lines, caseFor(q).yearMonth);
    const ctx = { ...caseFor(q), lines, facts: { ...caseFor(q).facts, ...(facts ?? {}) } };
    let next = confirm(q, ctx, now(), judgeFor(q));
    // 医師確認の練習問題は、情報不足が残っている（医師に聞かずに確定した）ときや、照合の不一致が残っているときは不正解（FR-76）
    if (q.drill && isDoctorDrill(q.drill)) {
      const d = doctorDrillOf(q.drill);
      const open = d.crosscheck ? crosscheckOf(q.claimId).mismatches.some((m) => m.ruleId === d.crosscheck) : false;
      // 条件つきの指摘（申告のとおりなら。design.md §18-3 判断 F）は確定の数に入れない
      next = { ...next, correct: next.confirmed!.result.findings.filter((f) => f.params?.conditional !== "1").length === 0 && !open };
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
  /** 確定した明細に、データで動く点検（G01〜）を掛けた結果（design.md §12-5）。区分をコードに直して掛け、確定のときの手書きの結果との重なりの規則を通す。読むだけで、問題には保存しない */
  function genericOf(q: Question, local?: LocalAbout) {
    const { yearMonth, recordsKnown } = caseFor(q);
    return genericOfLines(q.confirmed?.lines ?? [], resolveRevision(yearMonth), yearMonth, q.confirmed?.result ?? { findings: [] }, recordsKnown, local, declarationViewOf(ctx, clock));
  }
  function explain(id: string) {
    const cur = loadQ(id);
    inPhase(cur, "判定", "解説に進めない段階");
    const q = toExplanation(cur);
    saveQ(q);
    return q;
  }
  function done(id: string) {
    const cur = loadQ(id);
    inPhase(cur, "解説", "終えられない段階");
    const q = finish(cur, now());
    saveQ(q);
    return q;
  }
  // 選択モード：問題は UKE の原案（医療事務が入力した明細）から作り、正誤はユスティだけで決める
  function choiceQ(id: string) {
    const q = loadQ(id);
    if (q.mode !== "選択") throw badRequest(`選択モードの問題ではない: ${id}`);
    if (q.phase !== "ヒント") throw conflict(`選べない段階: ${q.phase}`);
    return q;
  }
  const choices = (id: string) => choiceItems(caseFor(choiceQ(id)), choiceGroups);
  function pick(id: string, lineIndex: number, option: string) {
    const q = choiceQ(id);
    const item = choiceItems(caseFor(q), choiceGroups).find((x) => x.lineIndex === lineIndex);
    if (!item) throw badRequest(`選択の問題がない行: ${lineIndex}`);
    if (!item.options.includes(option)) throw badRequest(`選択肢にない: ${option}`);
    const r = judgePick(caseFor(q), choiceGroups, lineIndex, option);
    saveQ({ ...q, picks: [...(q.picks ?? []), { lineIndex, option, correct: r.correct, at: now() }] });
    return r;
  }
  // 件数・レベル・防いだ額は月末の UKE の問題（提出）だけで数える。訪問の時点の問題は数えない（FR-68）
  const submitted = () => allQ().filter((q) => !q.asOf);
  const status = (clerkId: string) => myStatus(submitted(), clerkId, levels, levelCfg.choiceWeight ?? 1, reviewedCount(clerkId));
  const questionsOf = (clerkId: string) => allQ().filter((q) => q.clerkId === clerkId);

  /** 医師確認の練習問題で、医師に聞く（推測で算定しない）。同じ問題から 2 回は送らない */
  function askDoctorForDrill(questionId: string) {
    const q = loadQ(questionId);
    const d = q.drill && isDoctorDrill(q.drill) ? doctorDrillOf(q.drill) : null;
    if (!d?.ask) throw badRequest("この問題では、ここから医師確認は送らない");
    if (q.phase !== "ヒント") throw conflict(`医師確認を送れない段階: ${q.phase}`);
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
    if (ctx.kind !== "demo") return { fix: [], doctor: [], unavailable: REAL_NO_DRILLS };
    const done = new Set(clerkId ? questionsOf(clerkId).filter((q) => q.drill && q.correct === true).map((q) => q.drill) : []);
    const mark = <T extends { id: string }>(xs: T[]) => xs.map((d) => ({ ...d, cleared: done.has(d.id) }));
    return { fix: mark(drillList()), doctor: mark(doctorDrillList()), unavailable: null };
  };

  return { loadQ, checkLines, startDrill, start, draft, confirmQ, genericOf, explain, done, choices, pick, submitted, status, questionsOf, askDoctorForDrill, drillState, drills };
}

export type Questions = ReturnType<typeof createQuestions>;
