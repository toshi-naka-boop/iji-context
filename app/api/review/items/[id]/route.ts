// API Route（薄い入口。処理は src/server/app/review.ts）。査定・返戻の明細 1 件（spec FR-202 の I-1）：選べる請求・行・指摘を返し、人が選んだ当て方・印・判定を残す。
// 監査ログの対象は明細の id だけ（氏名・番号は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { reviewItemBody, reviewItemParams } from "../../../../../src/server/schemas/review";

export const GET = route({ roles: allow("GET /api/review/items/[id]"), params: reviewItemParams }, ({ params }) => getApp().reviewItem(Number(params.id)));

export const POST = route({ roles: allow("POST /api/review/items/[id]"), params: reviewItemParams, body: reviewItemBody }, ({ params, body, clerkId }) => {
  const a = getApp();
  const id = Number(params.id);
  switch (body.action) {
    case "claim":
      return a.pickClaim(id, body.claimId);
    case "line":
      return a.pickLine(id, body.line);
    case "confirm":
      return a.confirmMatch(id, clerkId);
    case "exclude":
      return a.excludeItem(id, body.reason, clerkId);
    case "judge":
      return a.judgeItem(id, clerkId, { result: body.result, ...(body.reason ? { reason: body.reason } : {}), ...(body.finding ? { finding: body.finding } : {}) });
  }
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
