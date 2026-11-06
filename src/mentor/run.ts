// Agent SDK の 1 回の呼び出しを回し、結果と所要時間の内訳を返す（メンター・ベテランのメンター・整文・通知の読み取りで共通）。
// 記録するのは時間・トークン・モデル名だけで、プロンプトや本文は残さない
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

export type RunResult = { structured: unknown; sessionId: string; stats: RunStats };

type Prompt = string | AsyncIterable<SDKUserMessage>;

/** 1 回分を回す。失敗（success 以外）は例外にする */
export async function runOnce(role: string, prompt: Prompt, options: Options): Promise<RunResult> {
  const started = Date.now();
  let sessionId = "";
  let structured: unknown = null;
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
    }
  }
  stats.totalMs = Date.now() - started;
  console.info(`[claude] ${JSON.stringify(stats)}`);
  return { structured, sessionId, stats };
}
