// API Route（薄い入口。処理は src/server/app/claim-reviews.ts）：取り込んだレセプトの点検で、本人が「この請求の点検を確かめた」を押す（design.md §14-3・段 17g）。
// 実在用のクリニックでだけ、F10 の処理件数に数える（同じ請求・同じ本人は 1 件）。返すのは本人の件数とレベルだけ（FR-16）
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { claimParams } from "../../../../../../src/server/schemas/patients";

export const POST = route({ roles: allow("POST /api/uke/claims/[claimId]/reviewed"), params: claimParams, audit: { target: ({ params }) => params.claimId } }, ({ params, clerkId }) => getApp().reviewClaim(params.claimId, clerkId));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
