// API Route（薄い入口。処理は src/server/app.ts）。UKE の取り込み（今回はデモ用の 2 本を選んで取り込むだけ）
import { body, authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => getApp().ukeList(ME));
}

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ clerkId: string; name: string }>(req);
    return getApp().importUke(ME, b.name);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
