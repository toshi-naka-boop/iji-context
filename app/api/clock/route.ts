// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { clockBody } from "../../../src/server/schemas/clock";

export const GET = route({ roles: allow("GET /api/clock") }, () => ({ now: getApp().now() }));

/** 時計を進める（デモ）。医師確認のリマインド・保留と、会議の日の整理が動く */
export const POST = route({ roles: allow("POST /api/clock"), body: clockBody, audit: { target: ({ body }) => body.now } }, ({ body }) => getApp().advanceClock(body.now));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
