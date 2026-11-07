// API Route から使うアプリの実体。ログインした人ごとに 1 クリニック（tenant）を持つ（spec FR-73）。
// tenant のデータは <RESEMEN_DATA>/tenants/<利用者 id>/ に置く（DB・知識・同期した Skill・医師確認の記録）。
// ログインしていない呼び出し（テスト・スクリプト・開発用の確認）は従来どおり data/resemen.db の 1 つを使う
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nextSmalltalkStreak, nextVentStreak, type Situation } from "../mentor/output";
import { modelFor } from "../mentor/models";
import type { Character } from "../mentor/prompt";
import { askVeteranMentor } from "../mentor/peer";
import { askMentor } from "../mentor/session";
import { clerkMemo, ensureWorkspace, skillsGeneration, workspaceRoot, workspaceSkillNames } from "../mentor/workspace";
import { crosscheckSkills } from "../uke/crosscheck";
import { extractFacts, type ChartNote } from "../chart/extract";
import type { VisitKind } from "../chart/notes";
import type { Style } from "../mentor/style";
import { defaultPaths, openApp, type App, type AppPaths } from "./app";
import { openAuth, type Auth, type User } from "./auth";
import { seed } from "../../scripts/seed-knowledge";
import { syncSkills } from "../../scripts/sync-skills";

let app: App | null = null;

/** データの置き場所（本番はディスクを付けた場所を RESEMEN_DATA で渡す） */
export const dataDir = () => path.resolve(process.env.RESEMEN_DATA ?? path.join(process.cwd(), "data"));

let auth: Auth | null = null;
export function getAuth(): Auth {
  auth ??= openAuth(path.join(dataDir(), "auth.db"));
  return auth;
}

/** いまの呼び出しが、どの利用者（tenant）のものか */
const current = new AsyncLocalStorage<User>();
export const runAs = <T>(user: User, fn: () => T): T => current.run(user, fn);
export const currentUser = (): User | null => current.getStore() ?? null;
/** tenant の中で、ログインした本人の医療事務 id（ベテラン役は vet1） */
export const ME = "new1";

const tenants = new Map<string, App>();
export function tenantPaths(id: string): AppPaths {
  if (!/^t[0-9a-f]{12}$/.test(id)) throw new Error(`利用者 id が不正: ${id}`);
  const dir = path.join(dataDir(), "tenants", id);
  return { root: process.cwd(), dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: path.join(dir, "query-log") };
}
/** 利用者のクリニックを開く。はじめての利用者には、制度層の知識を入れて Skill を同期してから開く */
function openTenant(user: User): App {
  const paths = tenantPaths(user.id);
  mkdirSync(path.dirname(paths.dbFile), { recursive: true });
  const store = { knowledgeDir: paths.knowledgeDir, skillsDir: paths.skillsDir };
  const fresh = !existsSync(paths.knowledgeDir);
  if (fresh) {
    seed(store);
    syncSkills(store);
  }
  const a = openApp(paths);
  // 根拠のある地域ルール（K6 の査定通知から）を 1 つ入れておく（FR-79）。すでにあれば（保管済みでも）入れ直さない
  a.seedLocalRules();
  a.upsertClerk({ id: ME, name: user.name, callName: "さん", characterId: "a", role: "clerk" });
  a.upsertClerk(DEMO_CLERKS[1]);
  return a;
}

/** デモ用の医療事務（新人とベテラン）。キャラはユーザーが決めるまで仮 */
const DEMO_CLERKS = [
  { id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" as const },
  { id: "vet1", name: "ベテラン", callName: "さん", characterId: "b", role: "veteran" as const },
];

export function getApp(): App {
  const u = currentUser();
  if (u) {
    let t = tenants.get(u.id);
    if (!t) {
      t = openTenant(u);
      tenants.set(u.id, t);
    }
    return t;
  }
  if (app) return app;
  const paths = defaultPaths(process.cwd());
  mkdirSync(path.dirname(paths.dbFile), { recursive: true });
  app = openApp(paths);
  for (const c of DEMO_CLERKS) app.upsertClerk(c);
  return app;
}

export function characters(): Character[] {
  return (JSON.parse(readFileSync(path.join(process.cwd(), "config", "characters.json"), "utf8")) as { characters: Character[] }).characters;
}

export function characterOf(id: string): Character {
  const c = characters().find((x) => x.id === id);
  if (!c) throw new Error(`キャラがない: ${id}`);
  return c;
}

/** 本人が選んだメンター（まだ選んでいなければ chosen=false）と、選べるキャラの一覧 */
export function mentorChoice(clerkId: string) {
  const a = getApp();
  return { chosen: a.characterChosen(clerkId), current: characterOf(a.clerk(clerkId).character_id), characters: characters(), style: a.styleOf(clerkId) };
}

export function chooseStyle(clerkId: string, style: Style) {
  getApp().setStyle(clerkId, style);
  return mentorChoice(clerkId);
}

export function chooseMentor(clerkId: string, characterId: string) {
  characterOf(characterId);
  getApp().chooseCharacter(clerkId, characterId);
  return mentorChoice(clerkId);
}

/**
 * 本人の作業場所を用意し、続けてよいセッション id を返す。
 * 知識の同期の世代が変わっていたら（design.md §5）、セッションを作り直す（null を返す）
 */
function prepare(a: App, clerkId: string): { workspace: { cwd: string; skills: string[] }; sessionId: string | null; generation: string } {
  const c = a.clerk(clerkId);
  const s = a.status(clerkId);
  const memo = clerkMemo({ name: c.name, callName: c.call_name, role: c.role, level: s.level, count: s.count, streak: s.streak }, a.questionsOf(clerkId));
  // 作業場所も利用者（tenant）ごとに分ける（医療事務の id は tenant ごとに同じ new1 になるため）
  const cwd = ensureWorkspace(path.join(workspaceRoot(), currentUser()?.id ?? "default"), clerkId, a.store.skillsDir, memo, crosscheckSkills());
  const generation = skillsGeneration(a.store.skillsDir);
  const same = a.setting(`session_gen:${clerkId}`) === generation;
  return { workspace: { cwd, skills: workspaceSkillNames(cwd) }, sessionId: same ? c.session_id : null, generation };
}

/** 続きのセッションで失敗したら（作業場所が変わって履歴が見つからないなど）、新しいセッションで一度だけやり直す */
async function withSession<T>(sessionId: string | null, run: (sid: string | null) => Promise<T>): Promise<T> {
  if (!sessionId) return run(null);
  try {
    return await run(sessionId);
  } catch (e) {
    console.warn(`[claude] セッションを作り直す: ${e instanceof Error ? e.message : String(e)}`);
    return run(null);
  }
}

/** ベテランのメンターに問う（ベテラン本人の作業場所・セッションで） */
async function askVeteran(a: App, question: string) {
  const vet = a.clerk("vet1");
  const p = prepare(a, vet.id);
  const r = await withSession(p.sessionId, (sid) => askVeteranMentor(a.store, question, sid, p.workspace, modelFor("veteranMentor")));
  a.setSession(vet.id, r.sessionId);
  a.setSetting(`session_gen:${vet.id}`, p.generation);
  return r;
}

/** メンターに話しかける（1 人 1 セッション。セッション id は clerks に残す） */
/**
 * skipCrosscheck：本人が「照合の不一致とは別のことを医師に聞きたい」と選んだとき。この 1 回だけ照合の不一致を渡さない
 */
export async function talkToMentor(input: { clerkId: string; questionId: string; message: string; situation: Situation; skipCrosscheck?: boolean }) {
  const a = getApp();
  const clerk = a.clerk(input.clerkId);
  const q = a.question(input.questionId);
  const latest = q.confirmed?.result ?? null;
  const draft = q.drafts.at(-1);
  // 訪問の時点の問題は、その日までの実施と記録で、月末まで決まらないルールを外して判定する（FR-68）
  const ctx = a.caseFor(q);
  const lines = q.confirmed?.lines ?? draft?.lines ?? ctx.lines;
  const engine = latest ?? a.judgeFor(q)({ ...ctx, lines });
  const p = prepare(a, clerk.id);
  const level = a.status(clerk.id).level;
  const r = await withSession(p.sessionId, (sid) =>
    askMentor(
      {
        store: a.store,
        queryLog: a.queryLog,
        askPeerMentor: async (question) => {
          const v = await askVeteran(a, question);
          if (!v.answer.answerable) return null;
          a.peerResolvedByMentor(clerk.id, question, v.answer.body);
          return v.answer.body;
        },
        askHuman: async (question) => a.peerToHuman(clerk.id, question),
        crosscheck: () =>
          input.skipCrosscheck ? [] : a.crosscheckOf(q.claimId, q.asOf, q.clerkId).mismatches.map((m) => ({
            ruleId: m.ruleId,
            disease: m.disease,
            why: m.draft.why,
            draft: m.draft,
            sent: m.query !== null,
          })),
      },
      {
        clerkId: clerk.id,
        sessionId: sid,
        character: characterOf(clerk.character_id),
        style: a.styleOf(clerk.id),
        level,
        ctx: { ...ctx, lines },
        engine,
        situation: input.situation,
        message: input.message,
        now: () => a.now(),
        model: modelFor("mentor", { level, scene: q.confirmed !== null ? "explain" : "hint" }),
        workspace: p.workspace,
        // 確定する前（ヒントの段階）は判定の中身を渡さない
        reveal: q.confirmed !== null,
        note: a.outlookOf(q) ?? undefined,
        smalltalkStreak: Number(a.setting(`smalltalk:${q.id}`) ?? "0"),
        ventStreak: Number(a.setting(`vent:${q.id}`) ?? "0"),
      },
    ),
  );
  a.setSession(clerk.id, r.sessionId);
  a.setSetting(`session_gen:${clerk.id}`, p.generation);
  // 数えるのは回数だけ。愚痴の中身はどこにも集計しない（事務長のレポートにも出さない）
  a.setSetting(`smalltalk:${q.id}`, String(nextSmalltalkStreak(Number(a.setting(`smalltalk:${q.id}`) ?? "0"), r.output.topic)));
  a.setSetting(`vent:${q.id}`, String(nextVentStreak(Number(a.setting(`vent:${q.id}`) ?? "0"), r.output.topic)));
  return r;
}

/** 訪問カルテを残し、AI が算定に要る事実を取り出す（FR-69）。取り出した事実は本人が確かめてから使う */
export async function writeChart(input: { claimId: string; clerkId: string; kind: VisitKind; note: ChartNote }) {
  const a = getApp();
  const saved = a.saveNote(input.claimId, input.clerkId, input.kind, input.note);
  const r = await extractFacts(input.note, modelFor("chartExtract"));
  return { ...saved, ...r };
}
