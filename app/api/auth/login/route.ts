// API Route：ログイン。失敗が続いたらしばらく受け付けない（ID ごと・接続元ごと）
import { Throttle } from "../../../../src/server/auth";
import { body, sessionCookie } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";

const failures = new Throttle(5, 600_000);

export async function POST(req: Request) {
  const b = await body<{ login: string; password: string }>(req).catch(() => ({ login: "", password: "" }));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const keys = [`id:${b.login}`, `ip:${ip}`];
  if (keys.some((k) => failures.blocked(k))) return Response.json({ error: "失敗が続いたため、10 分ほど待ってからもう一度試してください" }, { status: 429 });
  const user = getAuth().login(String(b.login ?? ""), String(b.password ?? ""));
  if (!user) {
    keys.forEach((k) => failures.hit(k));
    return Response.json({ error: "ログイン ID かパスワードが違います" }, { status: 401 });
  }
  failures.clear(`id:${b.login}`);
  const s = getAuth().createSession(user.id);
  return Response.json({ user: { login: user.login, name: user.name } }, { headers: { "set-cookie": sessionCookie(s.token, s.expires) } });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
