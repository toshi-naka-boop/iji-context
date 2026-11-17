// 入口でのログインの確かめ（楽観的な確認だけ。cookie があるかを見る）。本当の確かめは各 API の route() がセッションで行う（spec FR-72）
// ログインしていない人を、画面はログイン画面へ、API は 401 にする。音声など、これから足す API も同じく守られる。
// GET 以外の API は、その前に Origin を確かめる（spec FR-138。ログイン・登録の API も含む）
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./src/server/auth-cookie";
import { originAllowed } from "./src/server/origin";

const OPEN_PAGES = ["/login"];
const OPEN_API = ["/api/auth/"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!originAllowed({ method: req.method, pathname, origin: req.headers.get("origin"), host: req.headers.get("host"), secFetchSite: req.headers.get("sec-fetch-site") })) {
    // どのルートに、ちがう Origin から来たかだけをサーバーログに残す（本文・cookie は出さない）
    console.warn(`[origin] ${req.method} ${pathname} を断った`);
    return NextResponse.json({ error: "この画面からの操作ではないため、受け付けられません" }, { status: 403 });
  }
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
