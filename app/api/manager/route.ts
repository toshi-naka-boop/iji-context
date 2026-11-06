// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
/** 事務長向けの集計（個人別には分けない） */
export async function GET() {
  return handle(() => getApp().manager());
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
