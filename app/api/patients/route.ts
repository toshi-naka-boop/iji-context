// API Route（薄い入口。処理は src/server/app.ts）。訪問カルテを書く患者の一覧（合成データ）
import { authed } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => getApp().patients());
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
