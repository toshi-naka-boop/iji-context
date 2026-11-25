// 動作確認用（impl-plan「一番危ない箇所」）：Agent SDK が Next.js の API Route の中で動くか。
// ツールなし・1 ターンで、短い応答が返ることだけを確かめる
import { runOnce } from "../../../src/llm/outbound";
import { route } from "../../../src/server/http";
import { allow } from "../../../src/server/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 本番では使わない（呼ぶたびに API を消費するため。権限表の dev の行で、route() が 404 を返す）。開発時もログインした人だけが呼べる（route() が確かめる）。回数制限を付ける
export const GET = route({ roles: allow("GET /api/sdk-check"), limit: "llm" }, async ({ user }) => {
  const started = Date.now();
  try {
    const r = await runOnce(user, "sdkCheck", "「動作確認OK」とだけ返してください。", { maxTurns: 1, tools: [], persistSession: false, settingSources: [] });
    return Response.json({ ok: true, model: r.stats.model ?? "", text: r.text, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }, { status: 500 });
  }
});
