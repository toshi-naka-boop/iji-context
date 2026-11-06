// API Route から使うアプリの実体（プロセスに 1 つ）。DB は data/resemen.db（.gitignore 済み）
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nextSmalltalkStreak, type Situation } from "../mentor/output";
import { modelFor } from "../mentor/models";
import type { Character } from "../mentor/prompt";
import { askVeteranMentor } from "../mentor/peer";
import { askMentor } from "../mentor/session";
import { clerkMemo, ensureWorkspace, skillsGeneration, workspaceRoot, workspaceSkillNames } from "../mentor/workspace";
import { crosscheckSkills } from "../uke/crosscheck";
import { defaultPaths, openApp, type App } from "./app";

let app: App | null = null;

/** デモ用の医療事務（新人とベテラン）。キャラはユーザーが決めるまで仮 */
const DEMO_CLERKS = [
  { id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" as const },
  { id: "vet1", name: "ベテラン", callName: "さん", characterId: "b", role: "veteran" as const },
];

export function getApp(): App {
  if (app) return app;
  const paths = defaultPaths(process.cwd());
  mkdirSync(path.dirname(paths.dbFile), { recursive: true });
  app = openApp(paths);
  for (const c of DEMO_CLERKS) app.upsertClerk(c);
  return app;
}

export function characterOf(id: string): Character {
  const all = JSON.parse(readFileSync(path.join(process.cwd(), "config", "characters.json"), "utf8")) as { characters: Character[] };
  const c = all.characters.find((x) => x.id === id);
  if (!c) throw new Error(`キャラがない: ${id}`);
  return c;
}

/**
 * 本人の作業場所を用意し、続けてよいセッション id を返す。
 * 知識の同期の世代が変わっていたら（design.md §5）、セッションを作り直す（null を返す）
 */
function prepare(a: App, clerkId: string): { workspace: { cwd: string; skills: string[] }; sessionId: string | null; generation: string } {
  const c = a.clerk(clerkId);
  const s = a.status(clerkId);
  const memo = clerkMemo({ name: c.name, callName: c.call_name, role: c.role, level: s.level, count: s.count, streak: s.streak }, a.questionsOf(clerkId));
  const cwd = ensureWorkspace(workspaceRoot(), clerkId, a.store.skillsDir, memo, crosscheckSkills());
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
  const ctx = a.caseOf(q.claimId);
  const lines = q.confirmed?.lines ?? draft?.lines ?? ctx.lines;
  const { evaluate } = await import("../engine");
  const engine = latest ?? evaluate({ ...ctx, lines });
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
          input.skipCrosscheck ? [] : a.crosscheckOf(q.claimId).mismatches.map((m) => ({
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
        smalltalkStreak: Number(a.setting(`smalltalk:${q.id}`) ?? "0"),
      },
    ),
  );
  a.setSession(clerk.id, r.sessionId);
  a.setSetting(`session_gen:${clerk.id}`, p.generation);
  a.setSetting(`smalltalk:${q.id}`, String(nextSmalltalkStreak(Number(a.setting(`smalltalk:${q.id}`) ?? "0"), r.output.topic)));
  return r;
}
