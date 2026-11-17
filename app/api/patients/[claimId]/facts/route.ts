// API Route（薄い入口。処理は src/server/app.ts）：患者ごとに確かめた情報の一覧（GET）と保存（POST）。確かめた人はセッションの本人
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimParams, factBody } from "../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/patients/[claimId]/facts"), params: claimParams }, ({ params }) => getApp().patientFacts(params.claimId));

export const POST = route({ roles: allow("POST /api/patients/[claimId]/facts"), params: claimParams, body: factBody }, ({ params, body: { fact }, clerkId }) =>
  getApp().savePatientFact(params.claimId, clerkId, { key: fact.key, value: fact.value, source: fact.source, validUntil: fact.validUntil }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
