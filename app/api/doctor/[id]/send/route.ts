// API Route（薄い入口。処理は src/server/app.ts）。メンター（AI）が書いた送る前の医師確認を、医療事務が中身を確かめて医師に送る（採点 r2 エンジニアの上司 #4）。
// 監査ログの対象は医師確認の id だけ
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { doctorQueryParams } from "../../../../../src/server/schemas/doctor";

export const POST = route({ roles: allow("POST /api/doctor/[id]/send"), params: doctorQueryParams }, ({ params }) => getApp().sendDoctor(params.id));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
