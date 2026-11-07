// API Route（薄い入口。処理は src/server/app.ts）。訪問の記録（レセコンに入れる前）の一覧（FR-68）
import { authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => getApp().visits(ME));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
