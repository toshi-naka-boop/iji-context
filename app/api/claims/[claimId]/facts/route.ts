// API Route（薄い入口。処理は src/server/app/claim-facts.ts）：請求ごとに確かめた事実の一覧（GET）と保存（POST）。確かめた人はセッションの本人。
// 医師あての事実は医師の役割だけ、医療事務あての事実は事務・ベテランだけが残せる（処理の中で分ける）。監査ログの対象は請求 id と事実のキーだけ（値は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimFactBody, claimParams } from "../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/claims/[claimId]/facts"), params: claimParams }, ({ params }) => getApp().claimFacts(params.claimId));

export const POST = route(
  { roles: allow("POST /api/claims/[claimId]/facts"), params: claimParams, body: claimFactBody, audit: { target: ({ body, params }) => `${params.claimId} ${body.fact.key}` } },
  ({ params, body: { fact }, clerkId, user }) => getApp().saveClaimFact(params.claimId, clerkId, user.role, { key: fact.key, date: fact.date, value: fact.value, source: fact.source }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
