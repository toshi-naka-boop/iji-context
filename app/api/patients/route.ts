// API Route（薄い入口。処理は src/server/app.ts）。訪問カルテを書く患者の一覧（合成データ）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/patients") }, () => getApp().patients());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
