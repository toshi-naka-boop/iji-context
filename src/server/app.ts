// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
// 中身は src/server/app/ に領域ごとに分けてある。ここは組み立てと再 export だけ
import { createCases } from "./app/cases";
import { createClaimFacts } from "./app/claim-facts";
import { createClerks } from "./app/clerks";
import { createClock } from "./app/clock";
import { openContext, type AppPaths } from "./app/context";
import type { TenantStatus } from "./tenant-kind";
import { createDoctor } from "./app/doctor";
import { createDoctorFacts } from "./app/doctor-facts";
import { createErase } from "./app/erase";
import { createFacility } from "./app/facility";
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
import { createUkeCheck } from "./app/uke-check";
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
  const questions = createQuestions(ctx, clock, clerks, casesOf, notes, doctor, questionCase);
  const peer = createPeer(ctx, clock);
  const knowledge = createKnowledgeOps(ctx, clock, uke, questionCase, questions);
  const localPairs = createLocalPairs(ctx, questions);
  const meeting = createMeeting(ctx, clock);
  const prevented = createPrevented(questions, doctor);
  const erase = createErase(ctx, uke, patientFactsOf);
  const revision = createRevision(uke, casesOf, notes);
  const doctorFacts = createDoctorFacts(ctx, clock, clerks, casesOf);
  const facility = createFacility(ctx, clock, uke);

  const { ukeList, importUke, sampleUke, uploadUke, importedClaims } = uke;
  const { patientFacts, savePatientFact, checkConnectorPatient } = patientFactsOf;
  const { claimFacts, saveClaimFact } = claimFactsOf;
  const { cases, caseOf, caseBurdenRatioOf } = casesOf;
  // 患者情報チェックには、症例側が持つ負担割合を添える（患者マスタに入っていないときだけ使う）
  const patientProfile = (claimId: string) => patientFactsOf.patientProfile(claimId, caseBurdenRatioOf(claimId));
  /** 取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11。何も記録しない）。背反の組の院内の知識は、見ている本人のレベルで出し方を分ける（§14-3） */
  const ukeCheck = createUkeCheck(uke, casesOf, patientProfile, claimFactsOf.answersOf, (claimId, clerkId) => ({ ...localPairs.aboutFor(clerkId), pressed: claimFactsOf.pressedOf(claimId) }));
  const localPairOps = createLocalPairOps(ctx, clock, ukeCheck.ukeCheck, localPairs.levelOf);
  // 院内の知識で押した事実は、書く前にサーバーが照らす（design.md §14-3。書くのは saveClaimFact の 1 か所）
  claimFactsOf.setLocalGuard(localPairOps.admitPress);
  const confirmCoverage = (claimId: string, clerkId: string, input: CoverageInput) => patientFactsOf.confirmCoverage(claimId, clerkId, input, caseBurdenRatioOf(claimId));
  const { saveNote, noteOf, confirmNote, deleteNote, listNotes, saveNoteComment, patients, visits } = notes;
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
    noteOf,
    confirmNote,
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
      return generic;
    },
    explain,
    done,
    question: loadQ,
    status,
    questionsOf,
    setting,
    setSetting,
    ...facility,
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
      const pairs = ((r as { generic?: GenericView }).generic?.findings ?? []).flatMap((f) => (f.check === "G05" && f.localPair ? [f.localPair] : []));
      const localPairTaken = pairs.filter((p, i) => pairs.findIndex((q) => samePair(p, q)) === i).map((p) => ({ ...p, polarities: localPairOps.takenPolarities(p) }));
      return { ...r, localReturns: localPairOps.returnsOf(claimId, r), localPairTaken };
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
