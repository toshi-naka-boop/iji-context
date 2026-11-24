// API Route（薄い入口。処理は src/server/app/care.ts）：「ほかの機関はないと確かめた」（design.md §18-2）。確かめた診療月は、開いた請求の診療年月
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { otherNoneBody } from "../../../../../src/server/schemas/care";
import { claimParams } from "../../../../../src/server/schemas/patients";

export const POST = route({ roles: allow("POST /api/patients/[claimId]/others-none"), params: claimParams, body: otherNoneBody, audit: { target: ({ params }) => `${params.claimId}・otherInstitutionsNone` } }, ({ params, body, clerkId }) => {
  getApp().saveOtherNone(params.claimId, clerkId, body);
  return getApp().careView(params.claimId);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
