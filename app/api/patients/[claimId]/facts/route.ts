// API Route（薄い入口。処理は src/server/app.ts）：患者ごとに確かめた情報の一覧（GET）と保存（POST）。確かめた人はセッションの本人
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimParams, factBody } from "../../../../../src/server/schemas/patients";
import type { PatientFactInput } from "../../../../../src/patient/facts";
import { z } from "zod";
import { date } from "../../../../../src/server/schemas/cases";

// validFrom・validUntil を付けると、その期間の認定を入れるときに「申請の結果ですか」を聞くか（applicationPending）を返す（round-87 C-560・C-563）
const periodQuery = z.strictObject({ validFrom: date.optional(), validUntil: date.optional() });
export const GET = route({ roles: allow("GET /api/patients/[claimId]/facts"), params: claimParams, query: periodQuery }, ({ params, query }) =>
  getApp().patientFacts(params.claimId, query.validFrom ? { validFrom: query.validFrom, validUntil: query.validUntil ?? null } : undefined),
);

export const POST = route({ roles: allow("POST /api/patients/[claimId]/facts"), params: claimParams, body: factBody }, ({ params, body: { fact }, clerkId, user }) =>
  getApp().savePatientFact(params.claimId, clerkId, { key: fact.key, value: fact.value as PatientFactInput["value"], source: fact.source, validUntil: fact.validUntil }, user.role),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
