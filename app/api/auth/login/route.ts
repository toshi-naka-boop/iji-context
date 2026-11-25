// API Route：ログイン。失敗が続いたらしばらく受け付けない（ID ごと・接続元ごと）
import { Throttle } from "../../../../src/server/auth";
import { UserError } from "../../../../src/server/errors";
import { route, sessionCookie } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { loginBody } from "../../../../src/server/schemas/auth";

const failures = new Throttle(5, 600_000);

// 監査は auth.db の auth_events に残す（成功・失敗）。ログイン ID そのものは残さず、当たった利用者の id だけ
export const POST = route({ roles: allow("POST /api/auth/login"), body: loginBody, audit: false }, ({ body: b, ip }) => {
  const auth = getAuth();
  const keys = [`id:${b.login}`, `ip:${ip}`];
  const known = auth.idOfLogin(b.login);
  if (keys.some((k) => failures.blocked(k))) {
    auth.recordEvent({ event: "login", result: "limited", userId: known?.id, tenantId: known?.tenantId, ip });
    throw new UserError(429, "失敗が続いたため、10 分ほど待ってからもう一度試してください");
  }
  const user = auth.login(b.login, b.password);
  if (!user) {
    keys.forEach((k) => failures.hit(k));
    auth.recordEvent({ event: "login", result: "fail", userId: known?.id, tenantId: known?.tenantId, ip });
    throw new UserError(401, "ログイン ID かパスワードが違います");
  }
  failures.clear(`id:${b.login}`);
  const s = auth.createSession(user.id);
  auth.recordEvent({ event: "login", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return Response.json({ user: { login: user.login, name: user.name } }, { headers: { "set-cookie": sessionCookie(s.token, s.expires) } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
