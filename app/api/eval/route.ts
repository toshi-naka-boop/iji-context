// 開発用の入口：prompt-eval を回す（API キーは開発サーバーのプロセスにだけある）。本番では 404
// GET /api/eval?ids=M1,M2 で一部だけ回せる
import { z } from "zod";
import { runEval } from "../../../eval/run-eval";
import { route } from "../../../src/server/http";
import { allow } from "../../../src/server/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 開発用のルートだけで使うので、スキーマはここに置く
const evalQuery = z.strictObject({ ids: z.string().max(400).regex(/^[A-Za-z0-9_,-]*$/).optional() });

// 権限表の dev の行：本番では route() が 404 を返し、開発時もログインした人だけが呼べる。LLM を呼ぶので、回数制限を付ける
export const GET = route({ roles: allow("GET /api/eval"), query: evalQuery, limit: "llm" }, async ({ query, user }) => {
  const ids = query.ids?.split(",").filter(Boolean);
  try {
    return Response.json(await runEval(process.cwd(), { ids }, user));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
