// 入口でのログインの確かめ（楽観的な確認だけ。cookie があるかを見る）。本当の確かめは各 API の route() がセッションで行う（spec FR-72）
// ログインしていない人を、画面はログイン画面へ、API は 401 にする。音声など、これから足す API も同じく守られる。
// GET 以外の API は、その前に Origin を確かめる（spec FR-138。ログイン・登録の API も含む）。断ったものは監査ログに残す（FR-140）
import { NextResponse, type NextRequest } from "next/server";
import { Throttle } from "./src/server/auth";
import { SESSION_COOKIE } from "./src/server/auth-cookie";
import { getAuth } from "./src/server/auth-db";
import { originAllowed } from "./src/server/origin";
import { clientIp } from "./src/server/rate-limit";

const OPEN_PAGES = ["/login"];
const OPEN_API = ["/api/auth/"];

/** 断った記録は、同じ相手（利用者。わからなければ接続元）から 1 分に 20 件まで（叩かれ続けても、記録で溢れないように。断ること自体は続ける） */
const deniedLog = new Throttle(20, 60_000);

/**
 * Origin で断ったことを、ログインまわりの記録（auth.db の auth_events）に残す。proxy はクリニックの DB を開かないので、こちらに置く。
 * 残すのは、操作（メソッドとパス）・結果・利用者（セッションがあれば。なければ不明＝null）・クリニック・接続元だけ。本文と cookie は残さない。
 * 記録に失敗しても、応答（403）は変えない
 */
function recordDenied(req: NextRequest, pathname: string) {
  try {
    const auth = getAuth();
    const user = auth.userOfSession(req.cookies.get(SESSION_COOKIE)?.value);
    const ip = clientIp(req);
    const key = user ? `user:${user.id}` : `ip:${ip}`;
    if (deniedLog.blocked(key)) return;
    deniedLog.hit(key);
    const route = pathname.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
    auth.recordEvent({ event: `origin:${req.method} ${route}`, result: "denied", userId: user?.id ?? null, tenantId: user?.tenantId ?? null, ip });
  } catch (e) {
    console.error(`[origin] 記録に失敗: ${e instanceof Error ? e.name : "error"}`);
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!originAllowed({ method: req.method, pathname, origin: req.headers.get("origin"), host: req.headers.get("host"), secFetchSite: req.headers.get("sec-fetch-site") })) {
    // どのルートに、ちがう Origin から来たかだけをサーバーログに残す（本文・cookie は出さない）
    console.warn(`[origin] ${req.method} ${pathname} を断った`);
    recordDenied(req, pathname);
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
