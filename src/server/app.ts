// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
// 中身は src/server/app/ に領域ごとに分けてある。ここは組み立てと再 export だけ
import { askShortStay, createCare, type CareHomeInput, type CareInput, type OtherInput } from "./app/care";
import { careScopeNotes, hasCareScene, hasOthersScene } from "../engine/care-judge";
import { kanriLines } from "../engine/predicates";
import { careStateOf, certifiedOf } from "../patient/facts";
import { monthRange } from "../demo/period";
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
import { createOxygenPrices, readOxygenPrices, type OxygenPriceInput } from "./app/oxygen";
import { HOME_OXYGEN_KANRI } from "../generic/g12";
import type { GenericAboutMore } from "../generic/types";
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
import { createReview } from "./app/review";
import { createRevision } from "./app/revision";
import { createStructured } from "./app/structured";
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
  // 介護保険・ほかの医療機関との調整の申告（design.md §18-2。v37）
  const care = createCare(ctx, clock, clerks);
  // 届け出た酸素の単価（design.md §19-3。v44）
  const oxygen = createOxygenPrices(ctx, clock, clerks);
  const casesOf = createCases(ctx, clock, uke, patientFactsOf, claimFactsOf, care);
  const structured = createStructured(ctx, clock, uke, patientFactsOf, clerks);
  const notes = createNotes(ctx, clock, clerks, uke, casesOf, structured);
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
  const note14 = createNote14(ctx, clock, uke, patientFactsOf);

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
    // 前の月の管理料の三値は、G12・G05 と同じ事実（design.md §19-13 の 3。G11 の背反の判定で HX-25 に使う）
    return { ...notes.torikawasure.run({ ...input, path: "uke", days: notes.actsDays(claimId), ...notes.textsOf(claimId), oxygen: { prevHomeOxygen: oxygenOf(claimId).prevHomeOxygen } }), coverage };
  };
  /** 取り込んだ請求の B の欄（月末の点検から。取り込んだレセプトの点検と同じ請求・文脈・手書きのルールの結果で掛ける） */
  const ukeTorikawasure = (claimId: string, clerkId: string) => {
    const base = { ...casesOf.caseOf(claimId), events: [], recordsKnown: false };
    return torikawasureOf(claimId, clerkId, { claim: uke.receiptOf(claimId).claim(), base, rev: resolveRevision(base.yearMonth), hand: casesOf.judge(base).findings });
  };
  /**
   * 酸素（G12・G02。design.md §19-3・§19-5）：届け出た単価と、前の診療年月の同じ患者（患者マスタの id）の取り込んだ請求に在宅酸素療法指導管理料があるか（三値）。
   * 前の月の請求がなければ「取り込んでいない」（請求のない月と区別できない。U-79 のとおり条件つきのまま）
   */
  const oxygenOf = (claimId: string): Pick<GenericAboutMore, "oxygenPrices" | "prevHomeOxygen"> => {
    const r = uke.receiptOf(claimId).receipt;
    const [y, m] = r.yearMonth.split("-").map(Number);
    const prevYm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const me = patientFactsOf.existingIdOf(r.patient);
    const prev = me === null ? [] : uke.ukeReceipts().filter((x) => x.yearMonth === prevYm && x.claimId !== claimId && patientFactsOf.existingIdOf(x.patient) === me);
    const hasKanri = (id: string) => uke.receiptOf(id).claim().units.some((u) => (u.days ?? []).some((n) => n > 0) && u.items.some((it) => it.kind === "SI" && HOME_OXYGEN_KANRI.includes(it.code)));
    return { oxygenPrices: readOxygenPrices(ctx), prevHomeOxygen: prev.length === 0 ? "取り込んでいない" : prev.some((x) => hasKanri(x.claimId)) ? "ある" : "ない" };
  };
  const ukeCheck = createUkeCheck(uke, casesOf, patientProfile, claimFactsOf.answersOf, (claimId, clerkId) => ({ ...localPairs.aboutFor(clerkId), pressed: claimFactsOf.pressedOf(claimId) }), () => declarationViewOf(ctx, clock), torikawasureOf, oxygenOf);
  const localPairOps = createLocalPairOps(ctx, clock, ukeCheck.ukeCheck, localPairs.levelOf);
  // 査定・返戻の突き合わせ（spec FR-202 の I-1）。当てた請求は、取り込んだレセプトの点検と同じ点検で点検し直す（何も記録しない側の点検。USED は出さない）
  const review = createReview(ctx, uke, ukeCheck.ukeCheck);
  // 院内の知識で押した事実は、書く前にサーバーが照らす（design.md §14-3。書くのは saveClaimFact の 1 か所）
  claimFactsOf.setLocalGuard(localPairOps.admitPress);
  const confirmCoverage = (claimId: string, clerkId: string, input: CoverageInput) => patientFactsOf.confirmCoverage(claimId, clerkId, input, caseBurdenRatioOf(claimId));
  const { saveNote, saveRecord, noteOf, confirmNote, confirmActs, actsReviewOf, actCandidates, searchMasters, savedActs, pickAct, foldAct, confirmRx, confirmedFixes, deleteNote, listNotes, saveNoteComment, patients, visits } = notes;
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
    /** 分からない略語の印（FR-211）：取り出した直後の印と、自由記述の印の語 */
    markExtracted: notes.markExtracted,
    abbrevMarksOf: notes.abbrevMarksOf,
    actCandidates,
    searchMasters,
    savedActs,
    pickAct,
    foldAct,
    confirmRx,
    confirmedFixes,
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
        : notes.torikawasure.run({ claim: claimOfLines(q.confirmed.lines, rev).claim, base, rev, path: "preview", days: notes.actsDays(q.claimId, q.clerkId), ...notes.textsOf(q.claimId, q.clerkId), hand: q.confirmed.result.findings });
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
    /** カルテの構造化データ（design.md §16-1。段 19a） */
    ...structured,
    /** 画面の操作の前に、カルテの請求の構造化データを接続先から読んで残す（C-440） */
    ensureStructuredOfNote: (noteId: number) => structured.ensureStructured(notes.claimIdOfNote(noteId)),
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
    // 介護保険・ほかの医療機関との調整の申告（design.md §18-2・§18-5）。答えの月は、開いた請求の診療年月（C-513）
    /** 届け出た酸素の単価（任意。design.md §19-3・§19-8） */
    oxygenPrices: oxygen.oxygenPrices,
    oxygenPriceKindOf: oxygen.oxygenPriceKindOf,
    saveOxygenPrice: (clerkId: string, input: OxygenPriceInput) => oxygen.saveOxygenPrice(clerkId, input),
    careHomes: care.careHomes,
    saveCareHome: (clerkId: string, input: CareHomeInput) => care.saveCareHome(clerkId, input),
    careView: (claimId: string) => {
      const { receipt } = uke.receiptOf(claimId);
      const patientId = patientFactsOf.ingest(receipt.patient);
      const eff = care.effectiveCare(patientId, receipt.yearMonth);
      const others = care.effectiveOthers(patientId, receipt.yearMonth);
      // 今までに残した 2 値の居住の場所（住まいの種別の申告がない月だけ判定に使う。画面には「古い入力です」）
      const legacy = eff.residenceType ? null : (patientFactsOf.latestPatientFacts(patientId).find((f) => f.key === "residence")?.value ?? null);
      return { claimId, yearMonth: receipt.yearMonth, care: eff, legacyResidence: legacy, others: others.rows, none: others.none, homes: care.careHomes() };
    },
    /**
     * 聞き取りの画面（design.md §18-5）：その診療年月の取り込んだ請求のうち、R20・R21 の場面の区分の行があり、使う申告が効いていない・分からない・
     * 認定の期限が診療年月の中か前・確かめ直す日を過ぎた患者（1 患者 1 枚。聞く問いだけ）と、点検の範囲に「見ていません」がある患者の数。
     * month を省くと、月ごとの数だけを返す（月の一覧の入口）
     */
    careCheck: (monthIn?: string, claimId?: string) => {
      // ?claim= で開いたときは、その請求の診療年月を開く（C-513。round-82 C-543）
      const month = monthIn ?? (claimId ? uke.receiptOf(claimId).receipt.yearMonth : undefined);
      const all = casesOf.cases().filter((c) => !month || c.yearMonth === month);
      const rows = all.flatMap((c) => {
        const rev = resolveRevision(c.yearMonth);
        const careScene = hasCareScene(c, rev.consts);
        const othersScene = hasOthersScene(c, rev.consts);
        if (!careScene && !othersScene) return [];
        const { receipt } = uke.receiptOf(c.claimId);
        const patientId = patientFactsOf.ingest(receipt.patient);
        const eff = care.effectiveCare(patientId, c.yearMonth);
        const certState = careStateOf(patientFactsOf.careRows(patientId), c.yearMonth);
        const cert = certifiedOf(certState);
        // 申請中が残る月も聞き取りの対象（認定の結果を聞く。EM U-71 の v40・v41 の書き足し）
        const applying = certState.known && certState.segments.some((g) => g.kind === "申請中");
        const residence = eff.residenceType?.value as { type: string; careHomeId?: string } | undefined;
        const home = residence?.careHomeId ? care.careHomes().find((h) => h.homeId === residence.careHomeId) : undefined;
        // 聞く問い（design.md §18-5）：申告がない・分からないのほか、判定に要る項目に「分からない」「欠け」が残るもの（round-82 C-541・X-391）
        const asks: ("careCert" | "residenceType" | "shortStay" | "others")[] = [];
        if (careScene) {
          // 認定：診療年月に効かない（期限が月の中か前・分からない・申請中のあとの月）患者だけ。期限が近いだけの患者は聞かない（P07。design.md §18-12 の 5）
          if (!cert.known || applying) asks.push("careCert");
          // 住まいの種別：申告がない・分からない・入所先の施設を付けていない（特養）・施設の値が分からない（確かめ直す日を過ぎたを含む）
          const facility = residence && residence.type !== "自宅" && residence.type !== "分からない";
          const h = c.care?.residence?.home ?? null;
          const homeOpen = residence?.type === "特養（地域密着型を含む）" ? !h || h.mitoriFacility === "分からない" : !!h && (h.placedPhysician === "分からない" || h.mitoriFacility === "分からない");
          if (!residence || residence.type === "分からない" || (facility && homeOpen) || (home && home.recheckOn < monthRange(c.yearMonth).end)) asks.push("residenceType");
          // 短期入所：申告がない・分からない・使ったが日付や退院日からかが欠けている
          const stay = eff.shortStay?.value as { status: string } | undefined;
          const uses = c.care?.shortStay?.status === "使った" ? c.care.shortStay.uses : [];
          const stayOpen = uses.some((u) => u.start === null || u.end === null || u.fromDischarge === "分からない");
          if (((!stay || stay.status === "分からない") && askShortStay(c.care ?? {})) || stayOpen) asks.push("shortStay");
        }
        if (othersScene) {
          // ほかの機関：申告がない・在医総管を取る側が分からない・(Ⅰ)2 の月に求めた機関の行がない・特別の関係やしていることが分からない
          const rows = c.others?.rows ?? [];
          const v2 = c.lines.some((l) => l.count > 0 && (rev.consts.visit2Kubun ?? []).includes(l.kubun));
          // その請求の場面で読む項目の「分からない」だけを見る（§18-2 C-514。round-83 X-403）：⑤ 管理料の行→在医総管を取る側、⑥ (Ⅰ)2 の行→求めた機関と求めた日、
          // ⑦ 訪問看護指示料の行→医療機関の特別の関係と、医療機関が行う訪問看護
          const kanri = kanriLines(c, rev.consts).length > 0;
          const shiji = c.lines.some((l) => l.count > 0 && l.kubun === rev.consts.care?.shiji);
          const med = rows.filter((r) => r.kind === "医療機関");
          const open =
            !c.others ||
            (kanri && rows.some((r) => r.kanriSide === "分からない")) ||
            (v2 && !rows.some((r) => r.activities["求めによる訪問診療の求めた側"] === "はい" && r.referredOn !== null)) ||
            (shiji && med.some((r) => r.specialRelation === "分からない" || (r.specialRelation === "はい" && (r.activities["医療機関が行う訪問看護"] ?? "分からない") === "分からない")));
          if (open) asks.push("others");
        }
        // 「見ていません」の文（最初の行の「見ている場面」は除く）。答えても消えないもの（月の途中の変化・読みが割れるなど）もカードに出す
        const notes = careScopeNotes(c, rev.consts).slice(1);
        return [{ claimId: c.claimId, yearMonth: c.yearMonth, patient: receipt.patient.name, asks, notDone: notes.length > 0, notes }];
      });
      // 画面に出すのは、聞く問いがあるか「見ていません」がある患者（月の帯の「見ていない」の人数は、画面に出る人数に入る）
      const shown = (r: (typeof rows)[number]) => r.asks.length > 0 || r.notDone;
      const months = [...new Set(rows.map((r) => r.yearMonth))].sort().map((m) => ({ month: m, targets: rows.filter((r) => r.yearMonth === m && shown(r)).length, notDone: rows.filter((r) => r.yearMonth === m && r.notDone).length }));
      return { month: month ?? null, months, targets: month ? rows.filter(shown) : [], notDoneCount: rows.filter((r) => r.notDone).length, homes: care.careHomes() };
    },
    saveCare: (claimId: string, clerkId: string, input: CareInput) => {
      const { receipt } = uke.receiptOf(claimId);
      return care.saveCare(patientFactsOf.ingest(receipt.patient), receipt.yearMonth, clerkId, input);
    },
    saveOther: (claimId: string, clerkId: string, input: OtherInput) => {
      const { receipt } = uke.receiptOf(claimId);
      return care.saveOther(patientFactsOf.ingest(receipt.patient), receipt.yearMonth, clerkId, input);
    },
    saveOtherNone: (claimId: string, clerkId: string, input: Parameters<typeof care.saveOtherNone>[3]) => {
      const { receipt } = uke.receiptOf(claimId);
      return care.saveOtherNone(patientFactsOf.ingest(receipt.patient), receipt.yearMonth, clerkId, input);
    },
    ...erase,
    ...review,
    ...revision,
    ...doctorFacts,
    ...peer,
    ...knowledge,
    ...meeting,
    ...prevented,
  };
}

export type App = ReturnType<typeof openApp>;
