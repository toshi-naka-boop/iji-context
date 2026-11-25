// API Route（薄い入口。処理は src/server/app/doctor-facts.ts）：医師に確かめてほしい項目の一覧（GET）と、決められなかった答え（その他・判定不能）の記録（POST）。医師の役割だけ。
// 決まった答えは、事実の入口（POST /api/claims/[claimId]/facts、POST /api/patients/[claimId]/facts）に残す。監査ログの対象は請求 id と項目だけ（答え・記述は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { doctorFactBody } from "../../../../src/server/schemas/doctor";

export const GET = route({ roles: allow("GET /api/doctor/facts") }, () => getApp().doctorFacts());

export const POST = route({ roles: allow("POST /api/doctor/facts"), body: doctorFactBody, audit: { target: ({ body }) => `${body.claimId} ${body.key}` } }, ({ body, clerkId }) =>
  getApp().noteDoctorFact(clerkId, { claimId: body.claimId, key: body.key, date: body.date, option: body.option, freeText: body.freeText }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
