// API Route（薄い入口。処理は src/server/app.ts）。訪問の記録（レセコンに入れる前）の一覧（FR-68）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/visits") }, ({ clerkId }) => getApp().visits(clerkId));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
