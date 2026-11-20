// 外部の AI サービスへ送る処理の、ただ 1 つの出口（design.md §11-11）。Agent SDK を読み込むのはこのファイルだけ（tests/llm/outbound.test.ts がソースを走査して縛る）。
// - 送る前に「誰の操作か」を受け取り、その利用者が今の版の注意書きに同意しているかを、ここで DB を見て確かめる。ルートの申告（権限表）は信じない
// - 請求から作る文脈は claimForAi を通ったものだけを受け取る（患者の識別子を持たない形。落とす場所はここ 1 か所）
// - 記録するのは時間・トークン・モデル名だけで、プロンプトや本文は残さない
import { createSdkMcpServer, deleteSession, query, tool, type HookCallbackMatcher, type HookEvent, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaimContext } from "../engine/types";
import type { User } from "../server/auth";
import { getAuth } from "../server/auth-db";
import { ConsentRequired } from "../server/errors";

// SDK の部品（自前のツールの登録・Hooks の型）も、ここを通して使う。これら自体は何も送らない
export { createSdkMcpServer, tool };
export type { HookCallbackMatcher, HookEvent, Options, SDKUserMessage };

// ---------------------------------------------------------------------------
// 誰の操作か

/** 利用者のいない呼び出しの印。このファイルの外では作れない（同じ形の値を作っても、下の照合を通らない） */
const BUNDLED = Object.freeze({ bundled: true as const });
export type Bundled = typeof BUNDLED;
/** 送る操作の主：セッションから作った利用者（ルートのハンドラが受け取るものをそのまま渡す）か、同梱の合成データだけを送る呼び出し */
export type Sender = User | Bundled;

/**
 * 利用者のいない呼び出し（種を作るスクリプト・評価のスクリプト）の入口。送ってよいのは同梱の合成データだけ。
 * app/ と src/server/ から読み込むことは、テストで禁じている（利用者の入力がこの入口から出ないように）
 */
export function outboundForBundled(): Bundled {
  return BUNDLED;
}

/**
 * 外部のサービス（AI・音声）へ送ってよいかを確かめる。利用者は、今の版の注意書きに同意していなければ送らずに例外にする。
 * 同意は呼ぶたびに DB から読む（呼び出し側が持っている値・ルートの申告を信じない）。音声（src/voice/）も同じ確認を使う
 */
export function assertMaySend(by: Sender): void {
  if (by === BUNDLED) return;
  const id = (by as Partial<User> | null | undefined)?.id;
  if (typeof id !== "string" || !getAuth().acceptedNotice(id)) throw new ConsentRequired();
}

/**
 * メンターのやり取り（Agent SDK がこのサーバーに残したセッションの記録）を消す。cwd はその人の作業場所。
 * 記録がもうないときは何もしない。AI のサービス側に送った内容は、ここからは消せない
 */
export async function forgetSession(sessionId: string, cwd: string): Promise<void> {
  try {
    await deleteSession(sessionId, { dir: cwd });
  } catch {
    /* 記録がない */
  }
}

// ---------------------------------------------------------------------------
// 識別子を外す

declare const AI_CLAIM: unique symbol;
/**
 * AI に渡してよい形の請求。請求 id（アプリが振った番号か、同梱の症例の番号）・診療年月・過去月の算定だけを持つ。
 * 患者の氏名・生年月日・保険者番号・記号番号・公費の番号・医療機関コードは、請求・患者マスタ・UKE のどこにあっても、この形には入らない。
 * 型に印を付けてあるので、AI に文脈を渡す側（src/mentor/）は claimForAi を通した値しか受け取れない
 */
export type AiClaim = Pick<ClaimContext, "claimId" | "yearMonth" | "history"> & { readonly [AI_CLAIM]: true };

/** 請求から、AI に渡してよい項目だけを写す（許した項目の一覧。載っていない項目は、あとから請求に足されても送られない） */
export function claimForAi(ctx: ClaimContext): AiClaim {
  return { claimId: ctx.claimId, yearMonth: ctx.yearMonth, ...(ctx.history ? { history: ctx.history.map((h) => ({ yearMonth: h.yearMonth, kubun: [...h.kubun] })) } : {}) } as AiClaim;
}

// ---------------------------------------------------------------------------
// 送る

export type RunStats = {
  role: string;
  model: string | null;
  /** 呼び出しから結果までの全体 */
  totalMs: number;
  /** プロセスの起動から最初のメッセージ（init）まで */
  startupMs: number | null;
  /** うち API（モデル）が使った時間 */
  apiMs: number | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  toolCalls: string[];
};

/** text は、形を指定しない呼び出しの返事の文（動作確認用） */
export type RunResult = { structured: unknown; text: string; sessionId: string; stats: RunStats };

type Prompt = string | AsyncIterable<SDKUserMessage>;

/**
 * Agent SDK の 1 回の呼び出しを回し、結果と所要時間の内訳を返す（メンター・ベテランのメンター・整文・通知の読み取り・カルテの読み取りで共通）。
 * 送る前に、by が送ってよい主かを確かめる（assertMaySend）。失敗（success 以外）は例外にする
 */
export async function runOnce(by: Sender, role: string, prompt: Prompt, options: Options): Promise<RunResult> {
  assertMaySend(by);
  const started = Date.now();
  let sessionId = "";
  let structured: unknown = null;
  let text = "";
  const stats: RunStats = { role, model: null, totalMs: 0, startupMs: null, apiMs: null, turns: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, toolCalls: [] };
  for await (const m of query({ prompt, options })) {
    if ("session_id" in m && m.session_id) sessionId = m.session_id;
    if (m.type === "system" && m.subtype === "init") {
      stats.startupMs ??= Date.now() - started;
      stats.model = m.model;
    }
    if (m.type === "assistant") {
      for (const c of m.message.content) if (c.type === "tool_use") stats.toolCalls.push(c.name);
    }
    if (m.type === "result") {
      const r = m as unknown as { duration_api_ms?: number; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
      stats.apiMs = r.duration_api_ms ?? null;
      stats.turns = r.num_turns ?? null;
      stats.inputTokens = r.usage?.input_tokens ?? null;
      stats.outputTokens = r.usage?.output_tokens ?? null;
      stats.cacheReadTokens = r.usage?.cache_read_input_tokens ?? null;
      if (m.subtype !== "success") throw new Error(`${role} が失敗した: ${m.subtype}`);
      structured = m.structured_output ?? null;
      text = m.result ?? "";
    }
  }
  stats.totalMs = Date.now() - started;
  console.info(`[claude] ${JSON.stringify(stats)}`);
  return { structured, text, sessionId, stats };
}
