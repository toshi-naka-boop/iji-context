// API Route（薄い入口。処理は src/server/app.ts）：患者マスタの加入情報と、患者情報チェック（P01〜P08）の指摘。宛先は医療事務
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimParams } from "../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/patients/[claimId]/profile"), params: claimParams }, ({ params }) => getApp().patientProfile(params.claimId));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
