// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

/** 医師には、医療事務がまだ送っていない（送る前の）質問を返さない */
export const GET = route({ roles: allow("GET /api/doctor") }, ({ user }) => getApp().doctorQueries(user.role === "doctor"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
