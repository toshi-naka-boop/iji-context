// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/doctor") }, () => getApp().doctorQueries());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
