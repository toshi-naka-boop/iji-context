// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
// 中身は src/server/app/ に領域ごとに分けてある。ここは組み立てと再 export だけ
import { createCases } from "./app/cases";
import { createClerks } from "./app/clerks";
import { createClock } from "./app/clock";
import { openContext, type AppPaths } from "./app/context";
import { createDoctor } from "./app/doctor";
import { createErase } from "./app/erase";
import { createKnowledgeOps } from "./app/knowledge";
import { createMeeting } from "./app/meeting";
import { createNotes } from "./app/notes";
import { createPatients, type CoverageInput } from "./app/patients";
import { createPeer } from "./app/peer";
import { createPrevented } from "./app/prevented";
import { createQuestionCase } from "./app/question-case";
import { createQuestions } from "./app/questions";
import { createUke } from "./app/uke";
import { createUkeCheck } from "./app/uke-check";
import { createAudit } from "./audit";
import { createDailyCounter } from "./rate-limit";

export { cleanName } from "./app/clerks";
export { DEFAULT_NOW } from "./app/clock";
export { defaultPaths, reviewDepsOf, storeOptionsOf, type AppPaths } from "./app/context";

export function openApp(paths: AppPaths) {
  const ctx = openContext(paths);
  const { sqlite, deps, store, queryLog, dataset, setting, setSetting } = ctx;
  const clock = createClock(ctx);
  const clerks = createClerks(ctx);
  const uke = createUke(ctx, clerks);
  const patientFactsOf = createPatients(ctx, clock, clerks, uke);
  const casesOf = createCases(ctx, clock, uke, patientFactsOf);
  const notes = createNotes(ctx, clock, clerks, uke, casesOf);
  const doctor = createDoctor(ctx, clock, uke, casesOf, notes);
  const questionCase = createQuestionCase(casesOf, notes, doctor);
  const questions = createQuestions(ctx, clock, clerks, casesOf, notes, doctor, questionCase);
  const peer = createPeer(ctx, clock);
  const knowledge = createKnowledgeOps(ctx, clock, casesOf, questionCase, questions);
  const meeting = createMeeting(ctx, clock);
  const prevented = createPrevented(questions, doctor);
  const { deleteUpload } = createErase(ctx, uke, patientFactsOf);

  const { now, advanceClock } = clock;
  const { upsertClerk, createClerk, clerk, setSession, chooseCharacter, characterChosen, setClerkName, welcomed, setStyle, styleOf } = clerks;
  const { ukeList, importUke, sampleUke, uploadUke, importedClaims } = uke;
  const { patientFacts, savePatientFact, checkConnectorPatient } = patientFactsOf;
  const { cases, caseOf, caseBurdenRatioOf } = casesOf;
  // 患者情報チェックには、症例側が持つ負担割合を添える（患者マスタに入っていないときだけ使う）
  const patientProfile = (claimId: string) => patientFactsOf.patientProfile(claimId, caseBurdenRatioOf(claimId));
  /** 取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11。何も記録しない） */
  const { ukeCheck } = createUkeCheck(uke, casesOf, patientProfile);
  const confirmCoverage = (claimId: string, clerkId: string, input: CoverageInput) => patientFactsOf.confirmCoverage(claimId, clerkId, input, caseBurdenRatioOf(claimId));
  const { saveNote, noteOf, confirmNote, patients, visits } = notes;
  /** カルテの画面の算定プレビュー（FR-101）。患者情報の指摘（P 系）は、ユスティの指摘とは別の欄として添える */
  const chartClaim = (noteId: number, choices: Record<string, string>) => {
    const claim = notes.claimOfNote(noteId, choices);
    return { ...claim, patientFindings: patientProfile(claim.claimId).findings };
  };
  const { doctorQueries, answerDoctor, approveDoctor, proxySubmit, confirmedDiseases, crosscheckOf, sendCrosscheck } = doctor;
  const { caseFor, judgeFor, outlookOf } = questionCase;
  const { loadQ, startDrill, start, draft, confirmQ, explain, done, choices, pick, status, questionsOf, askDoctorForDrill, drillState, drills } = questions;
  const { peerList, peerListFor, peerResolvedByMentor, peerToHuman, peerAnswerByHuman } = peer;
  const { queue, verify, empathize, propose, knowledgeList, resolveNoticeItems, registerNotice, seedLocalRules, localRulesOf, checkOfficial } = knowledge;
  const { importClaimResult, agenda, answerAgenda, runMeeting } = meeting;
  const { personal, manager } = prevented;

  return {
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
    chartClaim,
    patients,
    outlookOf,
    patientFacts,
    savePatientFact,
    patientProfile,
    confirmCoverage,
    checkConnectorPatient,
    now,
    advanceClock,
    upsertClerk,
    createClerk,
    ukeList,
    importUke,
    sampleUke,
    uploadUke,
    ukeCheck,
    deleteUpload,
    importedClaims,
    clerk,
    setSession,
    chooseCharacter,
    characterChosen,
    setClerkName,
    welcomed,
    setStyle,
    styleOf,
    start,
    choices,
    pick,
    draft,
    confirm: confirmQ,
    explain,
    done,
    question: loadQ,
    status,
    questionsOf,
    setting,
    setSetting,
    importClaimResult,
    doctorQueries,
    answerDoctor,
    approveDoctor,
    agenda,
    answerAgenda,
    runMeeting,
    crosscheckOf,
    peerList,
    peerListFor,
    proxySubmit,
    queue,
    verify,
    empathize,
    propose,
    knowledgeList,
    checkOfficial,
    resolveNoticeItems,
    registerNotice,
    seedLocalRules,
    localRulesOf,
    peerResolvedByMentor,
    peerToHuman,
    peerAnswerByHuman,
    sendCrosscheck,
    confirmedDiseases,
    personal,
    manager,
  };
}

export type App = ReturnType<typeof openApp>;
