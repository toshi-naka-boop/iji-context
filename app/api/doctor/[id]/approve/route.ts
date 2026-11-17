// API Route（薄い入口。処理は src/server/app.ts）。承認するのは医師ロールの本人。承認者はセッションから決め、本文は受け取らない（FR-33・FR-134）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { doctorQueryParams } from "../../../../../src/server/schemas/doctor";

export const POST = route({ roles: allow("POST /api/doctor/[id]/approve"), params: doctorQueryParams }, ({ params, user }) =>
  getApp().approveDoctor(params.id, user.name, user.id),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
