// 動作確認用（impl-plan「一番危ない箇所」）：Agent SDK が Next.js の API Route の中で動くか。
// ツールなし・1 ターンで、短い応答が返ることだけを確かめる
import { query } from "@anthropic-ai/claude-agent-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // 本番では使わない（呼ぶたびに API を消費するため）
  if (process.env.NODE_ENV === "production") return new Response("Not Found", { status: 404 });
  const started = Date.now();
  try {
    let text = "";
    let model = "";
    for await (const m of query({
      prompt: "「動作確認OK」とだけ返してください。",
      options: { maxTurns: 1, tools: [], persistSession: false, settingSources: [] },
    })) {
      if (m.type === "system" && m.subtype === "init") model = m.model;
      if (m.type === "result" && m.subtype === "success") text = m.result;
    }
    return Response.json({ ok: true, model, text, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }, { status: 500 });
  }
}
