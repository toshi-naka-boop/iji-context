// API Route：自分のパスワードを変える（採点 r2 事務長 #4）。今のパスワード（仮のパスワードを含む）を入れ直して確かめる。
// 変えたら、いまのセッション以外のセッションを消す。監査ログには操作の名前だけ、auth_events には結果だけを残す（パスワードは残さない）
import { SESSION_COOKIE } from "../../../../src/server/auth";
import { UserError } from "../../../../src/server/errors";
import { cookieOf, route } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { passwordChangeBody } from "../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/auth/password"), body: passwordChangeBody }, ({ req, user, body, ip }) => {
  try {
    getAuth().changePassword(user, body.current, body.next, cookieOf(req, SESSION_COOKIE));
  } catch (e) {
    if (e instanceof UserError) getAuth().recordEvent({ event: "password.change", result: "fail", userId: user.id, tenantId: user.tenantId, ip });
    throw e;
  }
  getAuth().recordEvent({ event: "password.change", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return { changed: true };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
