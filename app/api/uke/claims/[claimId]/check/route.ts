// API Route（薄い入口。処理は src/server/app/uke-check.ts）。取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11）。読むだけで、何も記録しない
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { claimParams } from "../../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/uke/claims/[claimId]/check"), params: claimParams }, async ({ params, clerkId }) => {
  // B の欄（G11）の規則の候補のため、その請求の構造化データを接続先から読んで残してから点検する（C-440）
  await getApp().ensureStructured(params.claimId);
  return getApp().ukeCheck(params.claimId, clerkId);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
