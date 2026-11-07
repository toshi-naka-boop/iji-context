// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CREATE_SQL } from "../db/schema";
import { ruleKubun } from "../engine";
import type { ClaimContext, ClaimLine, Facility } from "../engine/types";
import { importResult, type SubmissionResult } from "../lifecycle/applications";
import type { Calendar } from "../lifecycle/calendar";
import { answerItem, buildDigest, dueMeeting, meetingReview, submit, type ReviewDeps } from "../lifecycle/review";
import { assertTime } from "../lifecycle/time";
import { answerQuery, approveQuery, listQueries, tickQueries, type BusinessDays, type QueryLog } from "../query/doctor-query";
import { checkDraft, confirm, finish, myStatus, startQuestion, toExplanation, type Mode, type Question } from "../practice/practice";
import { choiceItems, judgePick, type ChoiceGroup } from "../practice/choice";
import { managerReport, personalView, preventedOf } from "../prevented/prevented";
import { toClaimContext, type UkeSources } from "../uke/cases";
import { candidateOf, resolveNotice, type Notice } from "../notice/notice";
import { crosscheck, type Chart } from "../uke/crosscheck";
import { escalationCandidate } from "../mentor/peer";
import { proxyConfirmDraft, type ScribeResult } from "../mentor/scribe";
import { verificationQueue } from "../lifecycle/queue";
import { applyEvent, createKnowledge, listKnowledge, readBody } from "../lifecycle/store";
import type { UkePatient } from "../uke/types";
import { askMissing } from "../query/doctor-query";
import { existsSync } from "node:fs";
import { parseUke } from "../uke/uke";
import { applyPatientFacts, isExpired, patientKeyOf, validatePatientFact, type PatientFact, type PatientFactInput } from "../patient/facts";

export type AppPaths = { root: string; dbFile: string; knowledgeDir: string; skillsDir: string; queryLogDir: string };

export function defaultPaths(root = process.cwd()): AppPaths {
  return {
    root,
    dbFile: path.join(root, "data", "resemen.db"),
    knowledgeDir: path.join(root, "knowledge"),
    skillsDir: path.join(root, ".claude", "skills"),
    queryLogDir: path.join(root, "query-log"),
  };
}

const APP_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clerks (id TEXT PRIMARY KEY, name TEXT NOT NULL, call_name TEXT NOT NULL, character_id TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT);
CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, clerk_id TEXT NOT NULL, claim_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patient_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_key TEXT NOT NULL, fact_key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, valid_until TEXT, checked_at TEXT NOT NULL, checked_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS peer_questions (id TEXT PRIMARY KEY, from_clerk TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answered_by TEXT, knowledge_id TEXT, created_at TEXT NOT NULL, answered_at TEXT);
`;

/** デモの時計の初期値（合成レセプトの診療年月の中） */
export const DEFAULT_NOW = "2025-03-10T09:00:00+09:00";

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

export function openApp(paths: AppPaths) {
  const sqlite = new Database(paths.dbFile);
  sqlite.exec(CREATE_SQL);
  sqlite.exec(APP_SQL);
  const db = drizzle(sqlite);
  const store = { knowledgeDir: paths.knowledgeDir, skillsDir: paths.skillsDir };
  const queryLog: QueryLog = { dir: paths.queryLogDir };
  const cfg = (f: string) => path.join(paths.root, "config", f);
  const calendar = json<Calendar>(cfg("calendar.json"));
  const businessDays = json<BusinessDays>(cfg("business-days.json"));
  const levelCfg = json<{ thresholds: number[]; choiceWeight?: number }>(cfg("levels.json"));
  const levels = levelCfg.thresholds;
  const choiceGroups = json<{ groups: ChoiceGroup[] }>(cfg("choice-groups.json")).groups;
  const reviewCfg = json<{ meetingWeekday: number }>(cfg("review.json"));
  const facility = json<Facility>(cfg("facility.json"));
  const deps: ReviewDeps = { db, store, calendar, ruleKubun };

  const setting = (key: string): string | null =>
    (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const setSetting = (key: string, value: string) =>
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

  // -------------------------------------------------------------------------
  // 症例（合成 UKE ＋ 合成カルテ側の事実）

  const ukeFiles = () => ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"].map((f) => parseUke(readFileSync(path.join(paths.root, f))));
  function patientOf(claimId: string): UkePatient {
    const r = ukeFiles().flatMap((f) => f.receipts).find((x) => x.claimId === claimId);
    if (!r) throw new Error(`UKE にないレセプト: ${claimId}`);
    return r.patient;
  }
  function cases(): ClaimContext[] {
    const files = ukeFiles();
    const out: ClaimContext[] = [];
    for (const file of files) {
      for (const r of file.receipts) {
        const k = r.claimId.split("-")[0];
        const c = json<ClaimContext>(path.join(paths.root, "fixtures", "cases", `${k}.json`));
        const facts = applyPatientFacts(c.facts, latestPatientFacts(patientKeyOf(r.patient)), now());
        out.push(toClaimContext(file, r.claimId, { facility, facts, events: c.events, history: c.history }));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 患者ごとに確かめた情報（履歴を残し、項目ごとに最新の 1 件を使う）

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
    validatePatientFact(f, now());
    const patientKey = patientKeyOf(patientOf(claimId));
    sqlite
      .prepare("INSERT INTO patient_facts (patient_key, fact_key, value, source, valid_until, checked_at, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(patientKey, f.key, JSON.stringify(f.value), f.source, f.validUntil, now(), clerkId);
    return patientFacts(claimId);
  }
  const caseOf = (claimId: string): ClaimContext => {
    const c = cases().find((x) => x.claimId === claimId);
    if (!c) throw new Error(`症例がない: ${claimId}`);
    return c;
  };
  const withLines = (claimId: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>): ClaimContext => {
    const c = caseOf(claimId);
    return { ...c, lines, facts: { ...c.facts, ...(facts ?? {}) } };
  };

  // -------------------------------------------------------------------------
  // 時計（デモでは「時計を進める」で動く）

  function now(): string {
    return setting("now") ?? DEFAULT_NOW;
  }

  /** 時計を進める。医師確認のリマインド・保留と、会議の日を過ぎていればレセメン会議の整理を回す */
  function advanceClock(to: string) {
    assertTime(to, "now");
    setSetting("now", to);
    const queries = tickQueries(queryLog, to, businessDays);
    const last = (sqlite.prepare("SELECT ran_at FROM reviews ORDER BY ran_at DESC LIMIT 1").get() as { ran_at: string } | undefined)?.ran_at ?? null;
    const meeting = dueMeeting(last, to, reviewCfg.meetingWeekday) ? meetingReview(deps, to) : null;
    return { now: to, queries, meeting };
  }

  // -------------------------------------------------------------------------
  // 医療事務

  function upsertClerk(c: { id: string; name: string; callName: string; characterId: string; role: "clerk" | "veteran" }) {
    sqlite
      .prepare("INSERT INTO clerks (id, name, call_name, character_id, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, call_name = excluded.call_name, character_id = excluded.character_id, role = excluded.role")
      .run(c.id, c.name, c.callName, c.characterId, c.role);
  }
  function clerk(id: string) {
    const r = sqlite.prepare("SELECT * FROM clerks WHERE id = ?").get(id) as { id: string; name: string; call_name: string; character_id: string; role: string; session_id: string | null } | undefined;
    if (!r) throw new Error(`医療事務が登録されていない: ${id}`);
    return r;
  }
  const setSession = (id: string, sessionId: string) => sqlite.prepare("UPDATE clerks SET session_id = ? WHERE id = ?").run(sessionId, id);

  // -------------------------------------------------------------------------
  // 処理体験（1 件＝1 問）

  const saveQ = (q: Question) =>
    sqlite.prepare("INSERT INTO questions (id, clerk_id, claim_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(q.id, q.clerkId, q.claimId, JSON.stringify(q));
  const loadQ = (id: string): Question => {
    const r = sqlite.prepare("SELECT data FROM questions WHERE id = ?").get(id) as { data: string } | undefined;
    if (!r) throw new Error(`問題がない: ${id}`);
    return JSON.parse(r.data) as Question;
  };
  const allQ = (): Question[] => (sqlite.prepare("SELECT data FROM questions").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Question);

  function start(clerkId: string, claimId: string, mode: Mode = "通常"): Question {
    clerk(clerkId);
    caseOf(claimId);
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n;
    const q = startQuestion(`q${String(n + 1).padStart(4, "0")}`, clerkId, claimId, now(), mode);
    saveQ(q);
    return q;
  }
  function draft(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const r = checkDraft(q, withLines(q.claimId, lines, facts), now());
    saveQ(r.question);
    return r;
  }
  /** 確定：エンジンが判定し、提出として適用記録を書く（ライフサイクルの submit） */
  function confirmQ(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const ctx = withLines(q.claimId, lines, facts);
    const next = confirm(q, ctx, now());
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
  const status = (clerkId: string) => myStatus(allQ(), clerkId, levels, levelCfg.choiceWeight ?? 1);
  const questionsOf = (clerkId: string) => allQ().filter((q) => q.clerkId === clerkId);

  // -------------------------------------------------------------------------
  // 提出結果・医師確認・会議・防いだ額

  const importClaimResult = (r: SubmissionResult) => importResult(db, r, now());
  const doctorQueries = () => listQueries(queryLog);
  const answerDoctor = (id: string, a: { option: string; freeText?: string; answeredBy: string }) => answerQuery(queryLog, id, a, now());
  const approveDoctor = (id: string, approver: string) => approveQuery(queryLog, id, approver, now());
  const agenda = () => buildDigest(deps);
  const answerAgenda = (itemId: string, answer: 1 | 2 | 3 | 4, freeText?: string) => answerItem(deps, { itemId, answer, freeText }, now());
  const runMeeting = () => meetingReview(deps, now());

  // -------------------------------------------------------------------------
  // F6 メンター同士：ベテランのメンター → ベテラン本人。解決した問いは知識候補（FR-14・FR-15）

  type PeerRow = { id: string; from_clerk: string; question: string; status: "回答待ち" | "解決"; answer: string | null; answered_by: string | null; knowledge_id: string | null; created_at: string; answered_at: string | null };
  const peerList = (): PeerRow[] => sqlite.prepare("SELECT * FROM peer_questions ORDER BY created_at, id").all() as PeerRow[];
  function newPeerId(): string {
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM peer_questions").get() as { n: number }).n;
    return `P${String(n + 1).padStart(4, "0")}`;
  }
  /** ベテランのメンターが答えた問いを記録し、知識候補にする */
  function peerResolvedByMentor(fromClerk: string, question: string, answer: string) {
    const id = newPeerId();
    const k = escalationCandidate(store, { id, question, answer, answeredBy: "veteran_mentor" }, now());
    sqlite.prepare("INSERT INTO peer_questions VALUES (?, ?, ?, '解決', ?, 'veteran_mentor', ?, ?, ?)").run(id, fromClerk, question, answer, k.id, now(), now());
    return { id, knowledgeId: k.id };
  }
  /** ベテラン本人に届ける（ベテランのメンター経由） */
  function peerToHuman(fromClerk: string, question: string) {
    const id = newPeerId();
    sqlite.prepare("INSERT INTO peer_questions (id, from_clerk, question, status, created_at) VALUES (?, ?, ?, '回答待ち', ?)").run(id, fromClerk, question, now());
    return { queued: id };
  }
  /** ベテラン本人の回答。知識候補（未検証）を作る */
  function peerAnswerByHuman(id: string, answer: string) {
    const row = peerList().find((r) => r.id === id);
    if (!row) throw new Error(`問いがない: ${id}`);
    if (row.status !== "回答待ち") throw new Error(`回答済み: ${id}`);
    if (!answer.trim()) throw new Error("回答が空");
    const k = escalationCandidate(store, { id, question: row.question, answer, answeredBy: "veteran" }, now());
    sqlite.prepare("UPDATE peer_questions SET status = '解決', answer = ?, answered_by = 'veteran', knowledge_id = ?, answered_at = ? WHERE id = ?").run(answer, k.id, now(), id);
    return { id, knowledgeId: k.id };
  }

  // -------------------------------------------------------------------------
  // 知識：検証キュー（FR-41・FR-65）と F11 提案・共感（FR-51）

  /** 検証キュー：未検証の知識を共感数の多い順（同数は古い順）。状態は変えない */
  const queue = () => verificationQueue(listKnowledge(store)).map((m) => ({ ...m, body: readBody(store, m.id) }));
  /** ベテランの検証（承認で承認済み、却下で保管） */
  function verify(id: string, approve: boolean, reason?: string) {
    return applyEvent(store, id, approve ? { type: "VERIFY_APPROVE" } : { type: "VERIFY_REJECT", reason: reason?.trim() || "ベテランの検証で却下" }, now()).meta;
  }
  /** 共感（候補の並び順だけに効く。状態は変えない） */
  const empathize = (id: string) => applyEvent(store, id, { type: "EMPATHY" }, now()).meta;
  /** 誰でも投稿できる改善提案（院内層の候補。既存の知識を直す案なら relates_to に対象を入れる） */
  function propose(input: { summary: string; body: string; relatesTo?: string | null }) {
    if (!input.summary.trim() || !input.body.trim()) throw new Error("要約と本文が必要");
    const n = listKnowledge(store).filter((m) => m.layer === "院内").length;
    return createKnowledge(
      store,
      { layer: "院内", slug: `proposal-${String(n + 1).padStart(4, "0")}`, summary: input.summary.trim().slice(0, 200), body: input.body.trim(), source: { type: "提案", ref: `proposal-${n + 1}` }, relates_to: input.relatesTo ?? null, match: {} },
      now(),
    );
  }
  // 査定・返戻の通知（FR-42・FR-43）：対応づけは決まった規則。知識の候補にするのは本人が確かめた項目だけ
  const resolveNoticeItems = (notice: Notice) => resolveNotice(notice, json<UkeSources>(path.join(paths.root, "fixtures", "uke", "patients.json")), cases());
  function registerNotice(notice: Notice, index: number, opts: { reexamFiled: boolean; fileName: string }) {
    const item = resolveNoticeItems(notice)[index];
    if (!item) throw new Error(`通知に ${index + 1} 件目の項目がない`);
    return createKnowledge(store, candidateOf(item, opts), now());
  }
  /** 知識の一覧（状態ごとの数を見せる用） */
  const knowledgeList = () => listKnowledge(store).map((m) => ({ id: m.id, layer: m.layer, status: m.status, summary: m.summary, empathy: m.empathy, hits: m.hits, misses: m.misses }));

  // -------------------------------------------------------------------------
  // F3 代行入力：整えた文を必ず医師確認に回す（FR-37）。足りない項目は推定せず聞く（FR-36）

  function proxySubmit(claimId: string, original: string, scribed: ScribeResult) {
    caseOf(claimId);
    const draft = proxyConfirmDraft(claimId, original, scribed.text);
    const doctorMissing = scribed.missing.filter((m) => m.target === "doctor");
    if (doctorMissing.length) draft.indicators.push({ source: "記載が足りない項目", text: doctorMissing.map((m) => `${m.field}（${m.why}）`).join("、") });
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
  function chartOf(claimId: string): Chart | null {
    const f = path.join(paths.root, "fixtures", "charts", `${claimId.split("-")[0]}.json`);
    return existsSync(f) ? json<Chart>(f) : null;
  }
  /** 確認してほしい点（照合）。同じ項目の医師確認がすでにあれば、その状態も返す */
  function crosscheckOf(claimId: string) {
    const chart = chartOf(claimId);
    if (!chart) return { mismatches: [], confirmed: confirmedDiseases(claimId) };
    const qs = doctorQueries().filter((q) => q.claimId === claimId);
    return {
      mismatches: crosscheck(patientOf(claimId), chart, confirmedDiseases(claimId)).map((m) => ({ ...m, query: qs.find((q) => q.field === m.draft.field && q.status !== "承認済み") ?? null })),
      confirmed: confirmedDiseases(claimId),
    };
  }
  /** 照合の不一致から医師確認を送る（ask_missing の宛先＝医師） */
  function sendCrosscheck(claimId: string, ruleId: string) {
    const m = crosscheckOf(claimId).mismatches.find((x) => x.ruleId === ruleId);
    if (!m) throw new Error(`不一致がない: ${claimId} ${ruleId}`);
    if (m.query) throw new Error(`医師確認はもう送ってある: ${m.query.id}`);
    return askMissing(queryLog, { target: "doctor", ...m.draft }, now());
  }

  function resolvedFields(claimId: string): string[] {
    return doctorQueries()
      .filter((q) => q.claimId === claimId && q.status === "承認済み")
      .map((q) => q.field.replace(/^fact:/, ""));
  }
  const preventedItems = (clerkId?: string) =>
    allQ()
      .filter((q) => !clerkId || q.clerkId === clerkId)
      .flatMap((q) => preventedOf(q, resolvedFields(q.claimId)));
  const personal = (clerkId: string, optIn: boolean) => personalView(preventedItems(clerkId), optIn);
  const manager = () => managerReport(preventedItems(), []);

  return {
    paths,
    deps,
    store,
    queryLog,
    close: () => sqlite.close(),
    cases,
    caseOf,
    patientFacts,
    savePatientFact,
    now,
    advanceClock,
    upsertClerk,
    clerk,
    setSession,
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
    proxySubmit,
    queue,
    verify,
    empathize,
    propose,
    knowledgeList,
    resolveNoticeItems,
    registerNotice,
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
