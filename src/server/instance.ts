// API Route から使うアプリの実体。利用者はクリニック（tenant）に属する（spec FR-73・FR-132）。
// tenant のデータは <RESEMEN_DATA>/tenants/<tenant id>/ に置く（DB・知識・同期した Skill・医師確認の記録）。
// tenant id は、そのクリニックを 1 人で始めた利用者の id（招待で入った利用者は、招待した側の tenant に属する）。
// ログインしていない呼び出し（テスト・スクリプト・開発用の確認）は従来どおり data/resemen.db の 1 つを使う
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { nextSmalltalkStreak, nextVentStreak, type Situation } from "../mentor/output";
import { modelFor } from "../mentor/models";
import { claimForAi, forgetSessions } from "../llm/outbound";
import type { Character } from "../mentor/prompt";
import { askVeteranMentor } from "../mentor/peer";
import { askMentor } from "../mentor/session";
import { clerkMemo, ensureWorkspace, skillsGeneration, workspaceRoot, workspaceSkillNames } from "../mentor/workspace";
import { crosscheckSkills } from "../uke/crosscheck";
import { extractFacts, type ChartNote } from "../chart/extract";
import { formatSoap } from "../chart/soap";
import { readChartImage } from "../chart/image";
import type { VisitKind } from "../chart/notes";
import type { Style } from "../mentor/style";
import { defaultPaths, openApp, storeOptionsOf, type App, type AppPaths } from "./app";
import { VETERAN_CLERK } from "./app/clerks";
import type { User } from "./auth";
import { dataDir, getAuth } from "./auth-db";
import { seed } from "../../scripts/seed-knowledge";
import { syncSkills } from "../../scripts/sync-skills";
import { UserError, notFound } from "./errors";

let app: App | null = null;

export { dataDir, getAuth };

/** いまの呼び出しが、どの利用者（tenant）のものか */
const current = new AsyncLocalStorage<User>();
/** その利用者として fn を動かす。fn が Promise を返すときは、終わるまでを「実行中」と数える（その間はクリニックの DB を閉じない） */
export function runAs<T>(user: User, fn: () => T): T {
  const id = user.tenantId;
  const leave = () => {
    const n = (active.get(id) ?? 1) - 1;
    if (n > 0) active.set(id, n);
    else active.delete(id);
  };
  active.set(id, (active.get(id) ?? 0) + 1);
  let out: T;
  try {
    out = current.run(user, fn);
  } catch (e) {
    leave();
    throw e;
  }
  if (out instanceof Promise) return out.finally(leave) as T;
  leave();
  return out;
}
export const currentUser = (): User | null => current.getStore() ?? null;
/** 1 人で始めたクリニックの持ち主（と、ログインなしの呼び出し）の医療事務 id。ベテラン役は VETERAN_CLERK（src/server/app/clerks.ts） */
const OWNER_CLERK = "new1";
/**
 * tenant の中での、その利用者の医療事務 id（clerks の行）。
 * 持ち主は、ロールを入れる前からある new1 の行をそのまま使う（既存のクリニックの問題・記録・メンターの会話を引き継ぐ）。
 * 招待で入った利用者は、自分の利用者 id の行を持つ
 */
export const clerkIdOf = (user: User): string => (user.id === user.tenantId ? OWNER_CLERK : user.id);

/**
 * 開いているクリニックの DB ハンドル。開いたままにする数に上限を置き、使われていない順に閉じる（LRU）。
 * Map は入れた順に並ぶので、使うたびに入れ直して、先頭を「いちばん長く使われていないもの」にする。
 * 処理は呼び出しのたびに getApp() で取り直すので、閉じたものは次に使うときに開き直る。
 * LLM の応答を待つ間ハンドルを持ち続ける処理（talkToMentor）があるので、実行中の呼び出しがあるクリニックは閉じない
 */
let maxOpenTenants = 50;
/** テスト用：開いたままにする数の上限を変える */
export const setMaxOpenTenants = (n: number) => {
  maxOpenTenants = n;
};
const tenants = new Map<string, App>();
/** クリニックごとの、実行中の呼び出しの数（runAs の中にいる間） */
const active = new Map<string, number>();
function touchTenant(id: string, a: App) {
  tenants.delete(id);
  tenants.set(id, a);
  if (tenants.size <= maxOpenTenants) return;
  for (const [old, t] of tenants) {
    if (tenants.size <= maxOpenTenants) break;
    if (old === id || (active.get(old) ?? 0) > 0) continue;
    tenants.delete(old);
    t.close();
  }
}
/**
 * クリニックを開き直す（未定のクリニックの使い方を選んだあと。種類で作り物・時計の振る舞いが変わるので、今の種類で開き直す）。
 * 次に getApp() を呼んだときに開く。ほかに実行中の呼び出しがあれば、そのハンドルは閉じずに手放す（使い終わったら捨てられる）
 */
export function reopenTenant(id: string) {
  const t = tenants.get(id);
  if (!t) return;
  tenants.delete(id);
  if ((active.get(id) ?? 0) <= 1) t.close();
}
/** 開いているクリニックの数（テスト用） */
export const openTenantCount = () => tenants.size;
export function tenantPaths(id: string): AppPaths {
  if (!/^t[0-9a-f]{12}$/.test(id)) throw new Error(`利用者 id が不正: ${id}`);
  const dir = path.join(dataDir(), "tenants", id);
  return { root: process.cwd(), dbFile: path.join(dir, "app.db"), knowledgeDir: path.join(dir, "knowledge"), skillsDir: path.join(dir, "skills"), queryLogDir: path.join(dir, "query-log") };
}
/**
 * クリニックを開く。はじめてのクリニックには、制度層の知識を入れて Skill を同期してから開く。
 * 種類（demo／real／未定）は auth.db のクリニックの行で決まる。demo のクリニックにだけ、作り物の種（院内ルール・K6 の地域ルール）を入れる
 */
function openTenant(tenantId: string): App {
  const paths = tenantPaths(tenantId);
  const kind = getAuth().tenantKind(tenantId);
  mkdirSync(path.dirname(paths.dbFile), { recursive: true });
  const store = storeOptionsOf(paths);
  const fresh = !existsSync(paths.knowledgeDir);
  if (fresh) {
    seed(store);
    syncSkills(store);
  }
  const a = openApp(paths, { kind });
  // デモのクリニックだけ：院内ルールの種と、根拠のある地域ルール（K6 の合成の査定通知から）を入れておく（FR-79・FR-80）。すでにあれば（保管済みでも）入れ直さない
  if (kind === "demo") a.seedLocalRules();
  a.upsertClerk(DEMO_CLERKS[1]);
  return a;
}
/** 利用者の医療事務の行を用意する（プロセスの中で、利用者ごとに 1 回） */
const ensured = new Set<string>();
function ensureClerk(a: App, user: User) {
  if (ensured.has(user.id)) return;
  a.upsertClerk({ id: clerkIdOf(user), name: user.name, callName: "さん", characterId: "a", role: user.id !== user.tenantId && user.role === "veteran" ? "veteran" : "clerk" });
  ensured.add(user.id);
}

/**
 * 実在のクリニックで、日付が変わっていれば医師確認のリマインド・保留と会議の整理を回す（src/server/app/clock.ts の catchUp。同じ日のうちは何もしない）。
 * 失敗しても、呼び出し（画面の操作）は止めない。サーバーログに残し、次の日か開き直したときにまた回す
 */
function catchUp(a: App) {
  try {
    a.catchUp();
  } catch (e) {
    console.error(`[clock] 日付が変わったときの処理に失敗: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : "error"}`);
  }
}

/** デモ用の医療事務（新人とベテラン）。キャラはユーザーが決めるまで仮 */
const DEMO_CLERKS = [
  { id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" as const },
  { id: VETERAN_CLERK, name: "ベテラン", callName: "さん", characterId: "b", role: "veteran" as const },
];

export function getApp(): App {
  const u = currentUser();
  if (u) {
    const t = tenants.get(u.tenantId) ?? openTenant(u.tenantId);
    touchTenant(u.tenantId, t);
    ensureClerk(t, u);
    catchUp(t);
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
  if (!c) throw notFound(`キャラがない: ${id}`);
  return c;
}

/** 本人が選んだメンター（まだ選んでいなければ chosen=false）と、選べるキャラの一覧 */
export function mentorChoice(clerkId: string) {
  const a = getApp();
  return { chosen: a.characterChosen(clerkId), welcomed: a.welcomed(clerkId), current: characterOf(a.clerk(clerkId).character_id), characters: characters(), style: a.styleOf(clerkId) };
}

export function chooseStyle(clerkId: string, style: Style) {
  getApp().setStyle(clerkId, style);
  return mentorChoice(clerkId);
}

/** 初回のあいさつで本人が決めた名前を保存する（FR-27） */
export function setClerkName(clerkId: string, name: string) {
  return { name: getApp().setClerkName(clerkId, name).name };
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
  // 作業場所も tenant ごとに分ける（持ち主の医療事務の id は tenant ごとに同じ new1 になるため）
  const cwd = ensureWorkspace(path.join(workspaceRoot(), currentUser()?.tenantId ?? "default"), clerkId, a.store.skillsDir, memo, crosscheckSkills());
  const generation = skillsGeneration(a.store.skillsDir);
  const same = a.setting(`session_gen:${clerkId}`) === generation;
  return { workspace: { cwd, skills: workspaceSkillNames(cwd) }, sessionId: same ? c.session_id : null, generation };
}

/**
 * 取り込んだファイルを消す（design.md §11-11）。DB とファイルは app.deleteUpload が 1 つのトランザクションで消す。
 * ここでは、その請求を相談した人のメンターのやり取り（セッションの記録。前に使って捨てたセッションの分も）と作業場所を消す（作業場所は、次に話しかけたときに作り直される）
 */
export async function deleteUkeUpload(sha256: string): Promise<{ deleted: string; claims: number }> {
  const r = getApp().deleteUpload(sha256);
  const root = path.join(workspaceRoot(), currentUser()?.tenantId ?? "default");
  for (const c of r.clerks) {
    if (!/^[A-Za-z0-9_-]+$/.test(c.id)) continue;
    const cwd = path.join(root, c.id);
    await forgetSessions(cwd, c.sessionIds);
    rmSync(cwd, { recursive: true, force: true });
  }
  return { deleted: sha256, claims: r.claimIds.length };
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

/** 問題がまだあるか。メンターの応答を待つ間に、その請求のファイルが消されると、問題も消えている */
function questionExists(a: App, questionId: string): boolean {
  try {
    a.question(questionId);
    return true;
  } catch (e) {
    if (e instanceof UserError && e.status === 404) return false;
    throw e;
  }
}
const ERASED = "この請求のファイルは消されました。やり取りは残していません";

/**
 * ベテランのメンターに問う（ベテラン本人の作業場所・セッションで）。
 * alive は、問いの元の請求がまだあるか。応答を待つ間に消されていたら、何も書かず、この作業場所のセッションの記録を消して断る（消した請求の問いを残さない）
 */
async function askVeteran(a: App, by: User, question: string, alive: () => boolean) {
  const vet = a.clerk(VETERAN_CLERK);
  const p = prepare(a, vet.id);
  let r: Awaited<ReturnType<typeof askVeteranMentor>>;
  try {
    r = await withSession(p.sessionId, (sid) => askVeteranMentor(by, a.store, question, sid, p.workspace, modelFor("veteranMentor")));
  } catch (e) {
    if (!alive()) await forgetSessions(p.workspace.cwd, []);
    throw e;
  }
  if (!alive()) {
    await forgetSessions(p.workspace.cwd, [r.sessionId]);
    throw notFound(ERASED);
  }
  a.setSession(vet.id, r.sessionId);
  a.setSetting(`session_gen:${vet.id}`, p.generation);
  return r;
}

/**
 * メンターに話しかける（1 人 1 セッション。セッション id は clerks に残す）。user は操作した本人（外部へ送る前に、同意を確かめるために渡す）。
 * skipCrosscheck：本人が「照合の不一致とは別のことを医師に聞きたい」と選んだとき。この 1 回だけ照合の不一致を渡さない
 */
export async function talkToMentor(input: { user: User; clerkId: string; questionId: string; message: string; situation: Situation; skipCrosscheck?: boolean }) {
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
  // 応答を待つ間に、この請求のファイルが消されることがある（design.md §11-11「消す」）。待ったあとの書き込みは、どれも直前に問題がまだあるかを確かめる
  const alive = () => questionExists(a, q.id);
  /** 消されていたとき：待つ間にできた記録（この人のセッションの記録、メンターが作った医師確認）を消す。DB には何も書かない */
  const cleanUp = async (sessionIds: string[]) => {
    await forgetSessions(p.workspace.cwd, sessionIds);
    a.forgetQueries([q.claimId]);
  };
  let r: Awaited<ReturnType<typeof askMentor>>;
  try {
    r = await withSession(p.sessionId, (sid) =>
    askMentor(
      {
        store: a.store,
        queryLog: a.queryLog,
        askPeerMentor: async (question) => {
          const v = await askVeteran(a, input.user, question, alive);
          if (!v.answer.answerable) return null;
          if (!alive()) throw notFound(ERASED);
          a.peerResolvedByMentor(clerk.id, question, v.answer.body, q.claimId);
          return v.answer.body;
        },
        askHuman: async (question) => {
          if (!alive()) throw notFound(ERASED);
          return a.peerToHuman(clerk.id, question, q.claimId);
        },
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
        by: input.user,
        clerkId: clerk.id,
        sessionId: sid,
        character: characterOf(clerk.character_id),
        style: a.styleOf(clerk.id),
        level,
        // メンターに渡す請求は、識別子を外した形だけ
        ctx: claimForAi(ctx),
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
  } catch (e) {
    if (!alive()) await cleanUp([]);
    throw e;
  }
  if (!alive()) {
    await cleanUp([r.sessionId]);
    throw notFound(ERASED);
  }
  a.setSession(clerk.id, r.sessionId);
  a.setSetting(`session_gen:${clerk.id}`, p.generation);
  // 数えるのは回数だけ。愚痴の中身はどこにも集計しない（事務長のレポートにも出さない）
  a.setSetting(`smalltalk:${q.id}`, String(nextSmalltalkStreak(Number(a.setting(`smalltalk:${q.id}`) ?? "0"), r.output.topic)));
  a.setSetting(`vent:${q.id}`, String(nextVentStreak(Number(a.setting(`vent:${q.id}`) ?? "0"), r.output.topic)));
  return r;
}

/** 訪問カルテを残し、AI が算定に要る事実を取り出す（FR-69）。取り出した事実は本人が確かめてから使う */
export async function writeChart(input: { user: User; claimId: string; clerkId: string; kind: VisitKind; note: ChartNote }) {
  const a = getApp();
  const saved = a.saveNote(input.claimId, input.clerkId, input.kind, input.note);
  const r = await extractFacts(input.user, input.note, modelFor("chartExtract"));
  return { ...saved, ...r };
}

/** 自由に書いたカルテを SOAP の欄に整える（Haiku）。保存はしない。本人が欄を確かめてから writeChart で残す */
export const formatChart = (user: User, text: string) => formatSoap(user, text, modelFor("chartSoap"));
export const readChartFromImage = (user: User, image: Buffer) => readChartImage(user, image, modelFor("chartImage"));
