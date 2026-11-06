// 開発用の入口：prompt-eval を回す（API キーは開発サーバーのプロセスにだけある）。本番では 404
// GET /api/eval?ids=M1,M2 で一部だけ回せる
import { runEval } from "../../../eval/run-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response("Not Found", { status: 404 });
  const ids = new URL(req.url).searchParams.get("ids")?.split(",").filter(Boolean);
  try {
    return Response.json(await runEval(process.cwd(), { ids }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
