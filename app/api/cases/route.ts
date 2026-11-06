// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
export async function GET() {
  return handle(() => getApp().cases());
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
