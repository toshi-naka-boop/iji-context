// API Route（薄い入口。処理は src/server/app/care.ts）：患者の介護の申告と、ほかの機関・入所先の施設の一覧（GET）、申告の 1 行（POST）。design.md §18-2・§18-5。
// 答えの月は、開いた請求の診療年月（C-513）。監査ログは項目の鍵だけ（値・施設名は残さない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { careBody } from "../../../../../src/server/schemas/care";
import { claimParams } from "../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/patients/[claimId]/care"), params: claimParams }, ({ params }) => getApp().careView(params.claimId));

export const POST = route({ roles: allow("POST /api/patients/[claimId]/care"), params: claimParams, body: careBody, audit: { target: ({ params, body }) => `${params.claimId}・${body.item}` } }, ({ params, body, clerkId }) => {
  getApp().saveCare(params.claimId, clerkId, body);
  return getApp().careView(params.claimId);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
