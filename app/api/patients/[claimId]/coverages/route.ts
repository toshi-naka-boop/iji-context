// API Route（薄い入口。処理は src/server/app.ts）：保険・公費の加入情報の確認入力。確かめた人はセッションの本人。
// 監査ログの対象は請求 id だけ（番号・期限は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimParams, coverageBody } from "../../../../../src/server/schemas/patients";

export const POST = route({ roles: allow("POST /api/patients/[claimId]/coverages"), params: claimParams, body: coverageBody }, ({ params, body: { coverage }, clerkId }) =>
  getApp().confirmCoverage(params.claimId, clerkId, coverage),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
