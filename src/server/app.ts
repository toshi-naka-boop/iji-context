// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
// 中身は src/server/app/ に領域ごとに分けてある。ここは組み立てと再 export だけ
import { createCases } from "./app/cases";
import { createClaimFacts } from "./app/claim-facts";
import { createClaimReviews } from "./app/claim-reviews";
import { createClerks } from "./app/clerks";
import { createClock } from "./app/clock";
import { openContext, type AppPaths } from "./app/context";
import type { TenantStatus } from "./tenant-kind";
import { createDoctor } from "./app/doctor";
import { createDoctorFacts } from "./app/doctor-facts";
import { createErase } from "./app/erase";
import { createFacility, declarationViewOf } from "./app/facility";
import { createNote14 } from "./app/note14";
import { createKnowledgeOps } from "./app/knowledge";
import { createLocalPairOps, createLocalPairs } from "./app/local-pairs";
import { samePair } from "../generic/local-pair";
import type { GenericView } from "../generic/view";
import { createMeeting } from "./app/meeting";
import { createNotes } from "./app/notes";
import { createPatients, type CoverageInput } from "./app/patients";
import { createPeer } from "./app/peer";
import { createPrevented } from "./app/prevented";
import { createQuestionCase } from "./app/question-case";
import { createQuestions } from "./app/questions";
import { createRevision } from "./app/revision";
import { createUke } from "./app/uke";
import { createUkeCheck, type TorikawasureOf } from "./app/uke-check";
import { claimOfLines } from "../generic/overlap";
import { resolveRevision } from "../engine/revisions";
import { createAudit } from "./audit";
import { createDailyCounter } from "./rate-limit";

export { cleanName } from "./app/clerks";
export { DEFAULT_NOW } from "./app/clock";
export { defaultPaths, reviewDepsOf, storeOptionsOf, type AppPaths } from "./app/context";

export function openApp(paths: AppPaths, opts: { kind?: TenantStatus; decidedAt?: string | null } = {}) {
  const ctx = openContext(paths, opts);
  const { sqlite, deps, store, queryLog, dataset, setting, setSetting } = ctx;
  const clock = createClock(ctx);
  const clerks = createClerks(ctx);
  const uke = createUke(ctx, clerks);
  const patientFactsOf = createPatients(ctx, clock, clerks, uke);
  const claimFactsOf = createClaimFacts(ctx, clock, clerks, uke);
  const casesOf = createCases(ctx, clock, uke, patientFactsOf, claimFactsOf);
  const notes = createNotes(ctx, clock, clerks, uke, casesOf);
  const doctor = createDoctor(ctx, clock, uke, casesOf, notes);
  const questionCase = createQuestionCase(casesOf, notes, doctor);
  // 実在用のクリニックでは、取り込んだレセプトの点検で確かめた請求も F10 の処理件数に数える（design.md §14-3・段 17g）
  const claimReviews = createClaimReviews(ctx, clock, () => new Map(uke.ukeReceipts().map((r) => [r.claimId, uke.sameMonthKey(r)])));
  const questions = createQuestions(ctx, clock, clerks, casesOf, notes, doctor, questionCase, claimReviews.countOf);
  const peer = createPeer(ctx, clock);
  const knowledge = createKnowledgeOps(ctx, clock, uke, questionCase, questions);
  const localPairs = createLocalPairs(ctx, questions);
  const meeting = createMeeting(ctx, clock);
  const prevented = createPrevented(questions, doctor);
  const erase = createErase(ctx, uke, patientFactsOf);
  const revision = createRevision(uke, casesOf, notes);
  const doctorFacts = createDoctorFacts(ctx, clock, clerks, casesOf);
  const facility = createFacility(ctx, clock, uke);
  const note14 = createNote14(ctx, clock, uke);

  const { ukeList, importUke, sampleUke, uploadUke, importedClaims } = uke;
  const { patientFacts, savePatientFact, checkConnectorPatient } = patientFactsOf;
  const { claimFacts, saveClaimFact } = claimFactsOf;
  const { cases, caseOf, caseBurdenRatioOf } = casesOf;
  // 患者情報チェックには、症例側が持つ負担割合を添える（患者マスタに入っていないときだけ使う）
  const patientProfile = (claimId: string) => patientFactsOf.patientProfile(claimId, caseBurdenRatioOf(claimId));
  /** 取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11。何も記録しない）。背反の組の院内の知識は、見ている本人のレベルで出し方を分ける（§14-3） */
  /**
   * 取り込んだ請求の B の欄（G11。design.md §15-8）：貼って確かめたカルテのある請求だけを見る。同じ診療年月の取り込んだ請求のうち、貼った患者・貼っていない患者の数を 1 行で出す（L-122）。
   * 貼っていない請求は、取り忘れを見ず、その理由を返す（指摘がないことを「取り忘れなし」に見せない）
   */
  const torikawasureOf: TorikawasureOf = (claimId, clerkId, input) => {
    const ym = input.base.yearMonth;
    const same = [...new Set([claimId, ...(clerkId ? uke.importedClaims(clerkId) : [])])].filter((id) => uke.receiptOf(id).receipt.yearMonth === ym);
    const counts = notes.recordCounts();
    const pasted = same.filter((id) => counts.has(id)).length;
    const coverage = `カルテを貼った患者だけを見ています（貼った ${pasted} 人・貼っていない ${same.length - pasted} 人）`;
    if (!counts.has(claimId)) return { skip: "カルテが貼られていないので、取り忘れは見ていません", coverage };
    return { ...notes.torikawasure.run({ ...input, path: "uke", days: notes.actsDays(claimId) }), coverage };
  };
  /** 取り込んだ請求の B の欄（月末の点検から。取り込んだレセプトの点検と同じ請求・文脈・手書きのルールの結果で掛ける） */
  const ukeTorikawasure = (claimId: string, clerkId: string) => {
    const base = { ...casesOf.caseOf(claimId), events: [], recordsKnown: false };
    return torikawasureOf(claimId, clerkId, { claim: uke.receiptOf(claimId).claim(), base, rev: resolveRevision(base.yearMonth), hand: casesOf.judge(base).findings });
  };
  const ukeCheck = createUkeCheck(uke, casesOf, patientProfile, claimFactsOf.answersOf, (claimId, clerkId) => ({ ...localPairs.aboutFor(clerkId), pressed: claimFactsOf.pressedOf(claimId) }), () => declarationViewOf(ctx, clock), torikawasureOf);
  const localPairOps = createLocalPairOps(ctx, clock, ukeCheck.ukeCheck, localPairs.levelOf);
  // 院内の知識で押した事実は、書く前にサーバーが照らす（design.md §14-3。書くのは saveClaimFact の 1 か所）
  claimFactsOf.setLocalGuard(localPairOps.admitPress);
  const confirmCoverage = (claimId: string, clerkId: string, input: CoverageInput) => patientFactsOf.confirmCoverage(claimId, clerkId, input, caseBurdenRatioOf(claimId));
  const { saveNote, saveRecord, noteOf, confirmNote, confirmActs, actsReviewOf, actCandidates, searchMasters, savedActs, pickAct, deleteNote, listNotes, saveNoteComment, patients, visits } = notes;
  /** カルテの画面の算定プレビュー（FR-101）。患者情報の指摘（P 系）は、ユスティの指摘とは別の欄として添える */
  const chartClaim = (noteId: number, choices: Record<string, string>, revId?: string, clerkId?: string) => {
    // 背反の組の院内の知識（design.md §14-3）は、見ている本人のレベルで出し方を分ける（試算には渡さない）
    const claim = notes.claimOfNote(noteId, choices, revId, revId === undefined ? localPairs.aboutFor(clerkId) : undefined);
    return { ...claim, patientFindings: patientProfile(claim.claimId).findings };
  };
  const { doctorQueries, answerDoctor, approveDoctor, proxySubmit, confirmedDiseases, crosscheckOf, sendCrosscheck } = doctor;
  const { caseFor, judgeFor, outlookOf } = questionCase;
  const { loadQ, startDrill, start, draft, confirmQ, genericOf, explain, done, choices, pick, status, questionsOf, askDoctorForDrill, drillState, drills } = questions;

  return {
    /** クリニックの種類（demo／real／未定）。開いている間は変わらない（未定から選んだときは、開き直す。src/server/instance.ts） */
    kind: ctx.kind,
    paths,
    deps,
    store,
    queryLog,
    dataset,
    close: () => sqlite.close(),
    audit: createAudit(sqlite),
    dailyCounter: createDailyCounter(sqlite),
    cases,
    caseOf,
    caseFor,
    judgeFor,
    visits,
    startDrill,
    drills,
    askDoctorForDrill,
    drillState,
    saveNote,
    saveRecord,
    /** 貼って確かめたカルテのある請求と、請求ごとの貼った回数（段 18c の報告。L-122） */
    recordCounts: notes.recordCounts,
    noteOf,
    confirmNote,
    confirmActs,
    actsReviewOf,
    actCandidates,
    searchMasters,
    savedActs,
    pickAct,
    deleteNote,
    listNotes,
    chartClaim,
    saveNoteComment,
    patients,
    outlookOf,
    patientFacts,
    savePatientFact,
    claimFacts,
    saveClaimFact,
    patientProfile,
    confirmCoverage,
    checkConnectorPatient,
    ukeList,
    importUke,
    sampleUke,
    uploadUke,
    importedClaims,
    start,
    choices,
    pick,
    draft,
    confirm: confirmQ,
    /** 月末の点検のデータで動く点検。背反の組の院内の知識は、問題の本人（自分の問題だけを開ける）のレベルで出し方を分ける（design.md §14-3） */
    questionGeneric: (q: Parameters<typeof genericOf>[0]) => {
      const { localUsed, ...generic } = genericOf(q, localPairs.aboutFor(q.clerkId));
      // 指摘に添えた承認済みの院内の知識に USED を出す（月末の点検。1 日 1 回）
      localPairOps.markUsed(q.claimId, localUsed);
      if (!q.confirmed) return generic;
      // B の欄（G11。design.md §15-9）：合成の症例は確定した明細の行と突き合わせる（preview）。取り込んだ請求は、取り込んだレセプトの点検と同じに
      // UKE の単位と、UKE に書いてあることだけの文脈（recordsKnown は偽）で突き合わせる（uke。design.md §15-8。反証 round-55 C-290）
      const base = { ...caseFor(q), lines: q.confirmed.lines };
      const rev = resolveRevision(base.yearMonth);
      const torikawasure = casesOf.isUploaded(q.claimId)
        ? ukeTorikawasure(q.claimId, q.clerkId)
        : notes.torikawasure.run({ claim: claimOfLines(q.confirmed.lines, rev).claim, base, rev, path: "preview", days: notes.actsDays(q.claimId, q.clerkId), hand: q.confirmed.result.findings });
      return { ...generic, torikawasure };
    },
    explain,
    done,
    question: loadQ,
    status,
    questionsOf,
    setting,
    setSetting,
    ...facility,
    /** 注14 の計算の道具（design.md §15-13） */
    note14Tool: note14.tool,
    saveNote14Worksheet: note14.saveWorksheet,
    note14Draft: note14.draftOf,
    doctorQueries,
    answerDoctor,
    approveDoctor,
    crosscheckOf,
    proxySubmit,
    sendCrosscheck,
    confirmedDiseases,
    // 領域の関数をそのまま全部出すもの（領域の側に足した関数は、ここを直さずに出る）
    ...clock,
    ...clerks,
    ...ukeCheck,
    /** 取り込んだレセプトの点検。指摘に添えた承認済みの院内の知識に USED を出す（design.md §14-3。1 日 1 回） */
    ukeCheck: (claimId: string, clerkId?: string) => {
      const r = ukeCheck.ukeCheck(claimId, clerkId);
      localPairOps.markUsed(claimId, (r as { localUsed?: string[] }).localUsed ?? []);
      // 「この請求のこの組が返戻・査定された」を出す組（design.md §14-4）。点検できたレセプト（行を返したもの）にだけ足す（読めない・版のないレセプトの形は変えない）
      // 作る入口のフォームが選ばせない向き（design.md §14-2）。作る入口を出す G05 の指摘の組ごと
      if (!("rows" in r)) return r;
      // 本人がこの請求の点検を確かめたか（実在用のクリニックだけ載る。本人の分だけ。design.md §14-3・段 17g）
      const reviewed = claimReviews.reviewedOf(claimId, clerkId);
      const pairs = ((r as { generic?: GenericView }).generic?.findings ?? []).flatMap((f) => (f.check === "G05" && f.localPair ? [f.localPair] : []));
      const localPairTaken = pairs.filter((p, i) => pairs.findIndex((q) => samePair(p, q)) === i).map((p) => ({ ...p, polarities: localPairOps.takenPolarities(p) }));
      return { ...r, localReturns: localPairOps.returnsOf(claimId, r), localPairTaken, ...(reviewed !== undefined ? { reviewed } : {}) };
    },
    /** 「この請求の点検を確かめた」（design.md §14-3・段 17g）。点検できたレセプト（行を返したもの）だけを数える。返すのは本人の件数とレベルだけ */
    reviewClaim: (claimId: string, clerkId: string) => {
      const out = claimReviews.review(claimId, clerkId, "rows" in ukeCheck.ukeCheck(claimId, clerkId));
      const s = questions.status(clerkId);
      return { ...out, count: s.count, level: s.level };
    },
    /** 「この請求のこの組が返戻・査定された」（design.md §14-4）。written は、取り消した押した事実の key（監査ログに足す） */
    localReturn: (claimId: string, clerkId: string, pair: { a: string; b: string; tani: 1 | 2 | 3 }) => localPairOps.localReturn(claimId, clerkId, pair, claimFactsOf.clearPressed),
    createPair: localPairOps.createPair,
    ...erase,
    ...revision,
    ...doctorFacts,
    ...peer,
    ...knowledge,
    ...meeting,
    ...prevented,
  };
}

export type App = ReturnType<typeof openApp>;
