// API Route（薄い入口。処理は src/server/app.ts）。回答するのは医師ロールの本人。回答者はセッションから決め、画面から送られた名前は使わない（FR-134）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { answerBody, doctorQueryParams } from "../../../../../src/server/schemas/doctor";

export const POST = route({ roles: allow("POST /api/doctor/[id]/answer"), params: doctorQueryParams, body: answerBody }, ({ params, body, user }) =>
  getApp().answerDoctor(params.id, { ...body, answeredBy: user.name, answeredById: user.id }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
