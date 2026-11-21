// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow, permits, POLICY } from "../../../src/server/policy";
import { clockBody } from "../../../src/server/schemas/clock";

/**
 * 今日と、クリニックの種類。canAdvance は、この人が日付を進められるか（demo のクリニックで、権限表の POST /api/clock に当たる人）。
 * real のクリニックでは、今日は実際の日付で、進められない
 */
export const GET = route({ roles: allow("GET /api/clock") }, ({ user }) => {
  const a = getApp();
  return { now: a.now(), kind: a.kind, canAdvance: a.kind === "demo" && permits(POLICY["POST /api/clock"].rule, user, () => false) };
});

/** 時計を進める（demo のクリニックだけ。real では断る）。医師確認のリマインド・保留と、会議の日の整理が動く */
export const POST = route({ roles: allow("POST /api/clock"), body: clockBody, audit: { target: ({ body }) => body.now } }, ({ body }) => getApp().advanceClock(body.now));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
