// 入口でのログインの確かめ（楽観的な確認だけ。cookie があるかを見る）。本当の確かめは各 API の authed がセッションで行う（spec FR-72）
// ログインしていない人を、画面はログイン画面へ、API は 401 にする。音声など、これから足す API も同じく守られる
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./src/server/auth-cookie";

const OPEN_PAGES = ["/login"];
const OPEN_API = ["/api/auth/"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN_PAGES.includes(pathname) || OPEN_API.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // 画像・Next の静的ファイルは除く
  matcher: ["/((?!_next/static|_next/image|favicon.ico|characters/).*)"],
};
