// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
export async function GET() {
  return handle(() => ({ now: getApp().now() }));
}

/** 時計を進める（デモ）。医師確認のリマインド・保留と、会議の日の整理が動く */
export async function POST(req: Request) {
  return handle(async () => getApp().advanceClock((await body<{ now: string }>(req)).now));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
