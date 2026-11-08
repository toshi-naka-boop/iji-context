// API Route：いまログインしている人（していなければ 401）
import { userOf } from "../../../../src/server/http";

export async function GET(req: Request) {
  const u = userOf(req);
  if (!u) return Response.json({ error: "ログインしてください" }, { status: 401 });
  return Response.json({ login: u.login, name: u.name });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
