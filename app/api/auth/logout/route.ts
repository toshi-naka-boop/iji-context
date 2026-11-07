// API Route：ログアウト（セッションを消し、cookie も消す）
import { SESSION_COOKIE } from "../../../../src/server/auth";
import { clearCookie, cookieOf } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";

export async function POST(req: Request) {
  getAuth().endSession(cookieOf(req, SESSION_COOKIE));
  return Response.json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
