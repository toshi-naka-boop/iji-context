// API Route（薄い入口。処理は src/server/app.ts）。UKE の取り込み（今回はデモ用の 2 本を選んで取り込むだけ）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { ukeBody } from "../../../src/server/schemas/cases";

export const GET = route({ roles: allow("GET /api/uke") }, ({ clerkId }) => getApp().ukeList(clerkId));

export const POST = route({ roles: allow("POST /api/uke"), body: ukeBody, audit: { target: ({ body }) => body.name } }, ({ body, clerkId }) => getApp().importUke(clerkId, body.name));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
