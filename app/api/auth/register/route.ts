// API Route：利用者の登録（誰でも登録できる。2026-11-07 ユーザー判断）。登録したらそのままログインする
import { Throttle } from "../../../../src/server/auth";
import { body, sessionCookie } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";

/** 同じ接続元からの登録を 1 時間に 20 回までにする（機械的な大量登録を遅らせる） */
const perIp = new Throttle(20, 3_600_000);

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (perIp.blocked(ip)) return Response.json({ error: "しばらくしてからもう一度試してください" }, { status: 429 });
  try {
    const b = await body<{ login: string; name: string; password: string }>(req);
    const user = getAuth().register(String(b.login ?? ""), String(b.name ?? ""), String(b.password ?? ""));
    perIp.hit(ip);
    const s = getAuth().createSession(user.id);
    return Response.json({ user: { login: user.login, name: user.name } }, { headers: { "set-cookie": sessionCookie(s.token, s.expires) } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
