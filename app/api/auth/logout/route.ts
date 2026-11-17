// API Route：ログアウト（セッションを消し、cookie も消す）
import { SESSION_COOKIE } from "../../../../src/server/auth";
import { clearCookie, cookieOf, route } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";

export const POST = route({ roles: allow("POST /api/auth/logout"), audit: false }, ({ req, viewer, ip }) => {
  getAuth().endSession(cookieOf(req, SESSION_COOKIE));
  if (viewer) getAuth().recordEvent({ event: "logout", result: "ok", userId: viewer.id, tenantId: viewer.tenantId, ip });
  return Response.json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
