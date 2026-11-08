// API Route の共通処理：例外を 400 の JSON にする。authed はログインした本人のクリニック（tenant）で処理を動かす（spec FR-72・FR-73）
import { SESSION_COOKIE, type User } from "./auth";
import { getAuth, runAs } from "./instance";

export async function handle(fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export function cookieOf(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const userOf = (req: Request): User | null => getAuth().userOfSession(cookieOf(req, SESSION_COOKIE));

/** ログインしていなければ 401。していれば、その人のクリニックで fn を動かす */
export async function authed(req: Request, fn: (user: User) => unknown | Promise<unknown>): Promise<Response> {
  const user = userOf(req);
  if (!user) return Response.json({ error: "ログインしてください" }, { status: 401 });
  return runAs(user, () => handle(() => fn(user)));
}

/** authed と同じくログインした本人で動かすが、JSON ではない応答（音声など）をそのまま返す */
export async function authedResponse(req: Request, fn: (user: User) => Promise<Response>): Promise<Response> {
  const user = userOf(req);
  if (!user) return Response.json({ error: "ログインしてください" }, { status: 401 });
  return runAs(user, async () => {
    try {
      return await fn(user);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });
}

/** セッションの cookie（httpOnly。本番は https だけで送る） */
export function sessionCookie(token: string, expires: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
