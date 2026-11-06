// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import type { SubmissionResult } from "../../../src/lifecycle/applications";

/** 提出結果の取り込み（記録だけ。知識は会議まで更新しない） */
export async function POST(req: Request) {
  return handle(async () => getApp().importClaimResult(await body<SubmissionResult>(req)));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
