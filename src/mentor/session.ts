// メンターのセッション（spec FR-10・FR-13、impl-plan F2）。医療事務 1 人に 1 セッション（Agent SDK）
// ツールは Skill（承認済みの知識を読む）と自前の 5 つだけを渡し、Claude Code の組み込みツール（ファイル操作・シェルなど）は使わせない
import { createSdkMcpServer, tool, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ClaimContext, EngineResult } from "../engine/types";
import { ANSWER_FALLBACK, leakedTerms, MENTOR_OUTPUT_SCHEMA, parseMentorOutput, type MentorOutput, type Situation } from "./output";
import { modelOptions, type ModelChoice } from "./models";
import { buildSystemPrompt, turnContext, type Character } from "./prompt";
import { runOnce, type RunStats } from "./run";
import { askMissingTool, askPeerThenHuman, markCited, queryHistory, type CrossItem, type MentorDeps } from "./tools";
import { skillGuard } from "./workspace";

export const SERVER = "resemen";
export const TOOL_NAMES = ["query_history", "ask_peer_mentor", "ask_human", "ask_doctor", "ask_missing"] as const;
export const ALLOWED_TOOLS = TOOL_NAMES.map((t) => `mcp__${SERVER}__${t}`);

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });

const indicator = z.object({ source: z.string(), text: z.string() });

/** 自前の 5 つのツールを持つ MCP サーバー（知識は Skill で読む）。ctx は今の 1 問の請求、now は時刻（決定的な処理に渡す） */
export function mentorServer(deps: MentorDeps, ctx: ClaimContext, now: () => string, onChoice?: (items: CrossItem[]) => void) {
  const doctor = {
    field: z.string().describe("何が足りないか"),
    why: z.string().describe("なぜ聞くか（医療事務向けの記録）"),
    question: z.string().describe("医師への質問。点数・金額・請求に触れない。誘導しない"),
    indicators: z.array(indicator).describe("カルテ等の記載の引用（出典と本文）"),
    options: z.array(z.string()).describe("選択肢。臨床的な選択肢を 2 つ以上と「その他」「判定不能」"),
  };
  const run = (fn: () => unknown) => {
    try {
      return text(fn());
    } catch (e) {
      return { ...text(`エラー: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  };
  /**
   * 医師確認：照合でまだ送っていない不一致があれば、メンターは質問を書かない。どれのことかは本人が画面で選ぶ
   * （話題の見分けを AI にさせない）。不一致がない、または本人が「それ以外」を選んだときだけ、メンターの文面で作る
   */
  const toDoctor = (a: { field: string; why: string; question: string; indicators: { source: string; text: string }[]; options: string[] }) => {
    const open = (deps.crosscheck?.() ?? []).filter((m) => !m.sent);
    if (open.length > 0) {
      onChoice?.(open);
      return {
        needsClerkChoice: open.map((m) => ({ ruleId: m.ruleId, about: m.draft.field.replace(/^SY:/, "") })),
        note: "カルテとの照合で見つかった不一致があります。医師確認はまだ作っていません。どれのことかは本人が画面のボタンで選びます。質問は書かずに、選んでもらうよう短く伝えてください",
      };
    }
    return askMissingTool(deps, { target: "doctor", claimId: ctx.claimId, createdBy: "mentor", ...a }, now());
  };
  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools: [
      tool("query_history", "今の請求の過去月の算定を返す", {}, async () => run(() => queryHistory(ctx))),
      tool("ask_peer_mentor", "ベテランのメンターに問いを渡す。解けなければベテラン本人に届く", { question: z.string() }, async (a) =>
        text(await askPeerThenHuman(deps, a.question)),
      ),
      tool("ask_human", "ベテラン本人に問いを届ける（ベテランのメンター経由）", { question: z.string() }, async (a) => text(await deps.askHuman(a.question))),
      tool("ask_doctor", "医師確認を作る（ask_missing の宛先＝医師と同じ）。照合の不一致がまだあれば作らずに、本人に選んでもらう", doctor, async (a) =>
        run(() => toDoctor({ ...a })),
      ),
      tool(
        "ask_missing",
        "足りない項目を聞く。宛先が doctor なら医師確認、clerk なら医療事務本人への確認",
        { target: z.enum(["doctor", "clerk"]), field: z.string(), why: z.string(), question: z.string().optional(), indicators: z.array(indicator).optional(), options: z.array(z.string()).optional() },
        async (a) =>
          run(() =>
            a.target === "clerk"
              ? askMissingTool(deps, { target: "clerk", claimId: ctx.claimId, field: a.field, why: a.why }, now())
              : toDoctor({ field: a.field, why: a.why, question: a.question ?? "", indicators: a.indicators ?? [], options: a.options ?? [] }),
          ),
      ),
    ],
  });
}

/**
 * 医師確認を作る直前の Hooks：関係する決まりを読む前には医師に聞かせない（決まった規則）。
 * 「関係する」は、このレセプトに当てはまるルール（エンジンの applied）と、照合の不一致の規則。そのどれかを読んでいることを求める。
 * 当てはまる決まりが 1 つもないときは、決まりの外なのでベテランのメンターに回させる。医療事務あての確認は止めない
 */
export function doctorReadGuard(reads: string[], relevant: () => string[]): HookCallbackMatcher {
  return {
    matcher: `mcp__${SERVER}__ask_doctor|mcp__${SERVER}__ask_missing`,
    hooks: [
      async (input) => {
        const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as { target?: string };
        if ((input as { tool_name?: string }).tool_name?.endsWith("ask_missing") && ti.target !== "doctor") return {};
        const rel = relevant();
        if (rel.some((id) => reads.includes(id))) return {};
        const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
        if (rel.length === 0) return deny("このレセプトに当てはまる決まりがない話題です。医師に聞く前に、ask_peer_mentor でベテランのメンターに相談してください");
        const names = rel.map((id) => (id.startsWith("crosscheck/") ? id.replace("/", "-") : `iji-${id.replace("/", "-")}`));
        return deny(`医師に聞く前に、このレセプトに当てはまる決まり（${names.join("、")}）のうち、話題に関係するものを読んでください`);
      },
    ],
  };
}

/** このレセプトで「関係する」決まりの知識 id（当てはまるルールと、照合の不一致の規則） */
export function relevantRules(applied: string[], cross: CrossItem[]): string[] {
  return [...applied.map((r) => `system/${r.toLowerCase()}`), ...cross.map((m) => `crosscheck/${m.ruleId.toLowerCase()}`)];
}

export type MentorTurn = {
  /** 医療事務本人の id。1 人に 1 セッション（前回のセッション id があれば続ける） */
  clerkId: string;
  sessionId: string | null;
  character: Character;
  level: number;
  ctx: ClaimContext;
  engine: EngineResult;
  situation: Situation;
  message: string;
  now: () => string;
  model?: ModelChoice;
  /** 本人の作業場所（cwd）と、有効にするスキル名 */
  workspace: { cwd: string; skills: string[] };
  /** 判定を本人に見せてよい段階か（確定後の解説は true、ヒントの段階は false） */
  reveal: boolean;
  /** この問いで、直前まで雑談が続いた回数（決まった規則で数える） */
  smalltalkStreak?: number;
  /** この問いで、直前まで愚痴が続いた回数（決まった規則で数える） */
  ventStreak?: number;
};

/**
 * メンターに 1 回話しかける。出力は検査してから返す。
 * ヒントの段階で答え（根拠の区分・指摘の種類・点数）に触れていたら、一度だけ言い直させる。それでも触れていたら決まった文に置き換える。
 * USED は、引用した知識のうち実際にスキルとして読んだものだけに出す
 */
export async function askMentor(deps: MentorDeps, t: MentorTurn): Promise<{ output: MentorOutput; sessionId: string; used: string[]; read: string[]; stats: RunStats[]; choices: { ruleId: string; about: string }[] }> {
  const guard = skillGuard(deps.store);
  const cross = () => deps.crosscheck?.() ?? [];
  /** 本人に選んでもらう照合の不一致（メンターが医師確認を作ろうとしたときに出る） */
  const choices = new Map<string, { ruleId: string; about: string }>();
  const options = {
    systemPrompt: buildSystemPrompt(t.character, t.level),
    cwd: t.workspace.cwd,
    settingSources: ["project" as const],
    tools: ["Skill"],
    skills: t.workspace.skills,
    allowedTools: ALLOWED_TOOLS,
    mcpServers: { [SERVER]: mentorServer(deps, t.ctx, t.now, (items) => items.forEach((m) => choices.set(m.ruleId, { ruleId: m.ruleId, about: m.draft.field.replace(/^SY:/, "") }))) },
    hooks: { ...guard.hooks, PreToolUse: [...(guard.hooks.PreToolUse ?? []), doctorReadGuard(guard.reads, () => relevantRules(t.engine.applied, cross()))] },
    outputFormat: { type: "json_schema" as const, schema: MENTOR_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 8,
    ...modelOptions(t.model),
  };
  const r = await runOnce("mentor", `${t.message}\n\n${turnContext(t.engine, t.reveal, cross(), t.smalltalkStreak ?? 0, t.now().slice(0, 10), t.ventStreak ?? 0)}`, { ...options, ...(t.sessionId ? { resume: t.sessionId } : {}) });
  const stats = [r.stats];
  let sessionId = r.sessionId || (t.sessionId ?? "");
  let output = parseMentorOutput(r.structured, t.situation);
  if (!t.reveal) {
    const leaks = leakedTerms(output.body, t.engine);
    if (leaks.length > 0) {
      const again = await runOnce(
        "mentor-retry",
        `さっきの返事は答え（${leaks.join("、")}）に触れていました。答えを言わずに、見るとよい場所を一つだけ示す形で書き直してください。さっきの返事は本人には見せていないので、書き直したことには触れないでください。`,
        { ...options, resume: sessionId },
      );
      stats.push(again.stats);
      sessionId = again.sessionId || sessionId;
      output = parseMentorOutput(again.structured, t.situation);
      if (leakedTerms(output.body, t.engine).length > 0) output = { ...output, body: ANSWER_FALLBACK, expression: "考え中" };
    }
  }
  const read = [...guard.reads];
  const cited = output.citedKnowledge.map((x) => read.find((id) => x === id || x === `iji-${id.replace("/", "-")}`)).filter((x): x is string => !!x);
  const used = markCited(deps.store, [...new Set(cited)], t.now());
  return { output: { ...output, citedKnowledge: [...new Set(cited)] }, sessionId, used, read, stats, choices: [...choices.values()] };
}
