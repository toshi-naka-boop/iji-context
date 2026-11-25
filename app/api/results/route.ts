// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { resultBody } from "../../../src/server/schemas/results";

/** 提出結果の取り込み（記録だけ。知識は会議まで更新しない） */
export const POST = route({ roles: allow("POST /api/results"), body: resultBody, audit: { target: ({ body }) => body.submissionId } }, ({ body }) => getApp().importClaimResult(body));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
