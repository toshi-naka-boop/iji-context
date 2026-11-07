// 画面から呼ぶ処理をまとめた層（API Route はここを薄く呼ぶだけ）。データは SQLite と、knowledge/・query-log/ のファイル
// 決定的な処理（エンジン・ライフサイクル・医師確認・処理体験）を組み合わせるだけで、ここで新しい判定はしない
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CREATE_SQL } from "../db/schema";
import { evaluate, ruleKubun } from "../engine";
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
import { validateStyle, type Style } from "../mentor/style";
import { contextAsOf, deferAtMidMonth, outlook, visitDays } from "../visit/as-of";
import { validateFacts, type ChartNote, type ExtractedFact } from "../chart/extract";
import { chartWithNotes, withNotes, type ConfirmedNote, type VisitKind } from "../chart/notes";
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
CREATE TABLE IF NOT EXISTS chart_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, facts TEXT, clerk_id TEXT NOT NULL, created_at TEXT NOT NULL);
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

  const UKE_FILES = ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"];
  const ukeFiles = () => UKE_FILES.map((f) => parseUke(readFileSync(path.join(paths.root, f))));
  /** UKE の取り込み（利用者ごとに記録。今回はデモ用の 2 本を選んで取り込むだけ） */
  const importedUke = (clerkId: string): string[] => JSON.parse(setting(`uke:${clerkId}`) ?? "[]") as string[];
  function ukeList(clerkId: string) {
    const done = importedUke(clerkId);
    return UKE_FILES.map((f, i) => {
      const u = ukeFiles()[i];
      const name = path.basename(f);
      return { name, payer: u.payer, prefecture: u.prefecture, billingMonth: u.billingMonth, receipts: u.receipts.map((x) => ({ claimId: x.claimId, patient: x.patient.name })), imported: done.includes(name) };
    });
  }
  function importUke(clerkId: string, name: string) {
    clerk(clerkId);
    if (!UKE_FILES.some((f) => path.basename(f) === name)) throw new Error(`取り込める UKE ではない: ${name}`);
    const done = importedUke(clerkId);
    if (!done.includes(name)) setSetting(`uke:${clerkId}`, JSON.stringify([...done, name]));
    return ukeList(clerkId);
  }
  /** 取り込んだ UKE に入っているレセプト（月末の点検の対象） */
  const importedClaims = (clerkId: string): string[] => ukeList(clerkId).filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId));
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
  /** 問題の請求：訪問の時点の問題なら、その日までの実施と記録だけにする（FR-68） */
  const caseAt = (claimId: string, asOf?: string, clerkId?: string): ClaimContext => (asOf ? contextAsOf(monthOf(claimId, clerkId), asOf) : caseOf(claimId));
  const caseFor = (q: Question) => caseAt(q.claimId, q.asOf, q.clerkId);
  /** 訪問の時点では、月末まで決まらないルールを指摘にしない */
  const judgeFor = (q: Question) => (q.asOf ? (c: ClaimContext) => deferAtMidMonth(evaluate(c)) : evaluate);
  const withLines = (claimId: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>, asOf?: string, clerkId?: string): ClaimContext => {
    const c = caseAt(claimId, asOf, clerkId);
    return { ...c, lines, facts: { ...c.facts, ...(facts ?? {}) } };
  };

  // -------------------------------------------------------------------------
  // 本人が書く訪問カルテ（FR-69）：書く → AI が事実を取り出す → 本人が確かめる → その月の請求に重ねる

  function saveNote(claimId: string, clerkId: string, kind: VisitKind, note: ChartNote): { id: number; date: string } {
    clerk(clerkId);
    const c = caseOf(claimId);
    if (kind !== "訪問診療" && kind !== "往診") throw new Error(`訪問の種類が不正: ${kind}`);
    const date = now().slice(0, 10);
    if (!date.startsWith(c.yearMonth)) throw new Error(`今日（${date}）は診療月 ${c.yearMonth} の外。時計を診療月に戻してください`);
    const r = sqlite
      .prepare("INSERT INTO chart_notes (claim_id, date, kind, note, facts, clerk_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .run(claimId, date, kind, JSON.stringify(note), clerkId, now());
    return { id: Number(r.lastInsertRowid), date };
  }
  type NoteRow = { id: number; claim_id: string; date: string; kind: string; note: string; facts: string | null };
  function noteRow(id: number): NoteRow {
    const r = sqlite.prepare("SELECT * FROM chart_notes WHERE id = ?").get(id) as NoteRow | undefined;
    if (!r) throw new Error(`カルテがない: ${id}`);
    return r;
  }
  const noteOf = (id: number) => JSON.parse(noteRow(id).note) as ChartNote;
  /** 本人が確かめた事実で確定する。どの事実も、カルテに書かれた言葉（quote）を持っていなければならない */
  function confirmNote(id: number, facts: ExtractedFact[]) {
    const r = noteRow(id);
    if (r.facts !== null) throw new Error(`もう確かめてある: ${id}`);
    const v = validateFacts({ facts }, JSON.parse(r.note) as ChartNote);
    if (v.dropped.length) throw new Error(`カルテにない言葉の事実がある: ${v.dropped.map((d) => d.why).join("、")}`);
    sqlite.prepare("UPDATE chart_notes SET facts = ? WHERE id = ?").run(JSON.stringify(v.facts), id);
    return { claimId: r.claim_id, date: r.date };
  }
  /** 本人が書いて確かめた訪問カルテ（利用者ごと。ほかの人が書いたカルテは重ねない） */
  function confirmedNotes(claimId: string, clerkId?: string): ConfirmedNote[] {
    if (!clerkId) return [];
    return (sqlite.prepare("SELECT * FROM chart_notes WHERE claim_id = ? AND clerk_id = ? AND facts IS NOT NULL ORDER BY id").all(claimId, clerkId) as NoteRow[]).map((r) => ({
      date: r.date,
      kind: r.kind as VisitKind,
      note: JSON.parse(r.note) as ChartNote,
      facts: JSON.parse(r.facts!) as ExtractedFact[],
    }));
  }
  /** その月の請求：UKE の症例に、本人が書いた訪問を重ねる（訪問の時点の問題で使う。月末の UKE の問題は UKE のまま） */
  const monthOf = (claimId: string, clerkId?: string): ClaimContext => withNotes(caseOf(claimId), confirmedNotes(claimId, clerkId));
  /** カルテを書く患者の一覧（訪問のある患者。氏名などは合成データ） */
  function patients() {
    return cases()
      .filter((c) => visitDays(c).length > 0)
      .map((c) => {
        const p = patientOf(c.claimId);
        const f = c.facts;
        const v = <T,>(x: { known: boolean; value?: T }) => (x.known ? (x as { value: T }).value : null);
        return {
          claimId: c.claimId,
          name: p.name,
          sex: p.sex === 1 ? "男" : "女",
          age: v(f.age),
          insurance: v(f.insurance),
          mainDisease: v(f.mainDisease),
          diseases: p.diseases.map((d) => d.name),
          careLevel: v(f.careLevel),
          table7: v(f.table7),
          table8_2: v(f.table8_2),
          homeOxygen: v(f.homeOxygen),
        };
      });
  }

  /** 訪問の記録（レセコンに入れる前）：その月の訪問日と、その日のカルテ。今日より先の日は open=false */
  function visits(clerkId?: string) {
    const today = now().slice(0, 10);
    return cases().map((c) => monthOf(c.claimId, clerkId)).flatMap((c) =>
      visitDays(c).map((d) => ({
        claimId: c.claimId,
        date: d.date,
        type: d.type,
        mainDisease: c.facts.mainDisease.known ? c.facts.mainDisease.value : null,
        chart: chartOf(c.claimId, clerkId)?.entries.find((e) => e.date === d.date) ?? null,
        /** その日までの実施（レセコンに入れる前の下書きの元） */
        lines: contextAsOf(c, d.date).lines,
        outlook: outlook(c, d.date),
        /** 本人が書いた訪問か */
        written: confirmedNotes(c.claimId, clerkId).some((n) => n.date === d.date),
        open: d.date <= today,
      })),
    ).sort((a, b) => (a.date === b.date ? (a.claimId < b.claimId ? -1 : 1) : a.date < b.date ? -1 : 1));
  }
  /** 訪問の時点の問題に添える見込み（指摘ではない） */
  const outlookOf = (q: Question) => (q.asOf ? outlook(monthOf(q.claimId, q.clerkId), q.asOf) : null);

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
      .prepare("INSERT INTO clerks (id, name, call_name, character_id, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, call_name = excluded.call_name, role = excluded.role")
      .run(c.id, c.name, c.callName, c.characterId, c.role);
  }
  /** 審査員などが自分の利用者を作る（名前は呼び方に使う）。キャラは選ぶまで仮の a */
  function createClerk(name: string) {
    const n = name.trim();
    if (n.length < 1 || n.length > 20) throw new Error("名前は 1〜20 文字");
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM clerks WHERE id LIKE 'u%'").get() as { n: number }).n;
    const id = `u${String(count + 1).padStart(4, "0")}`;
    upsertClerk({ id, name: n, callName: "さん", characterId: "a", role: "clerk" });
    return clerk(id);
  }
  function clerk(id: string) {
    const r = sqlite.prepare("SELECT * FROM clerks WHERE id = ?").get(id) as { id: string; name: string; call_name: string; character_id: string; role: string; session_id: string | null } | undefined;
    if (!r) throw new Error(`医療事務が登録されていない: ${id}`);
    return r;
  }
  const setSession = (id: string, sessionId: string) => sqlite.prepare("UPDATE clerks SET session_id = ? WHERE id = ?").run(sessionId, id);
  /** 本人がメンターを選ぶ（FR-19）。指示はセッションの初めに渡すので、キャラを変えたらセッションを作り直す */
  function chooseCharacter(id: string, characterId: string) {
    clerk(id);
    sqlite.prepare("UPDATE clerks SET character_id = ?, session_id = NULL WHERE id = ?").run(characterId, id);
    setSetting(`character_chosen:${id}`, "1");
  }
  const characterChosen = (id: string) => setting(`character_chosen:${id}`) === "1";
  /** 伝え方のタイプ（FR-20。本人の申告、任意）。指示はセッションの初めに渡すので、変えたらセッションを作り直す */
  function setStyle(id: string, style: Style) {
    clerk(id);
    setSetting(`style:${id}`, JSON.stringify(validateStyle(style)));
    sqlite.prepare("UPDATE clerks SET session_id = NULL WHERE id = ?").run(id);
  }
  const styleOf = (id: string): Style => JSON.parse(setting(`style:${id}`) ?? "{}") as Style;

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

  function start(clerkId: string, claimId: string, mode: Mode = "通常", asOf?: string): Question {
    clerk(clerkId);
    const c = monthOf(claimId, clerkId);
    if (asOf) {
      if (mode !== "通常") throw new Error("訪問の時点の問題は通常モードだけ");
      if (!visitDays(c).some((d) => d.date === asOf)) throw new Error(`この日の訪問はない: ${claimId} ${asOf}`);
      if (asOf > now().slice(0, 10)) throw new Error(`まだ来ていない日: ${asOf}`);
    }
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n;
    const q = startQuestion(`q${String(n + 1).padStart(4, "0")}`, clerkId, claimId, now(), mode, asOf);
    saveQ(q);
    return q;
  }
  function draft(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const r = checkDraft(q, withLines(q.claimId, lines, facts, q.asOf, q.clerkId), now(), judgeFor(q));
    saveQ(r.question);
    return r;
  }
  /** 確定：エンジンが判定し、提出として適用記録を書く（ライフサイクルの submit） */
  function confirmQ(id: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>) {
    const q = loadQ(id);
    const ctx = withLines(q.claimId, lines, facts, q.asOf, q.clerkId);
    const next = confirm(q, ctx, now(), judgeFor(q));
    // 訪問の時点の確定は提出ではない（レセコンに入れる前）。適用記録は月末の UKE の問題でだけ書く
    if (q.asOf) {
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
  /** 照合用のカルテ：合成カルテに、本人が書いて確かめた訪問カルテを重ねる（FR-69） */
  function chartOf(claimId: string, clerkId?: string): Chart | null {
    const f = path.join(paths.root, "fixtures", "charts", `${claimId.split("-")[0]}.json`);
    return chartWithNotes(existsSync(f) ? json<Chart>(f) : null, claimId, confirmedNotes(claimId, clerkId));
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
    submitted()
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
    caseFor,
    judgeFor,
    visits,
    saveNote,
    noteOf,
    confirmNote,
    patients,
    outlookOf,
    patientFacts,
    savePatientFact,
    now,
    advanceClock,
    upsertClerk,
    createClerk,
    ukeList,
    importUke,
    importedClaims,
    clerk,
    setSession,
    chooseCharacter,
    characterChosen,
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
