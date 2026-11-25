// API Route（薄い入口。処理は src/server/app/structured.ts）。医療事務が入れる訪問の開始・終了の時刻を追記で残す（design.md §16-6・16-7）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { visitTimeBody } from "../../../../../src/server/schemas/chart";

// 監査ログの対象は請求の id だけ（時刻の値は残さない）
export const POST = route({ roles: allow("POST /api/chart/structured/visit-time"), body: visitTimeBody, audit: { target: ({ body }) => body.claimId } }, ({ body, clerkId }) =>
  getApp().saveVisitTime(clerkId, { claimId: body.claimId, date: body.date, ...(body.ref ? { ref: body.ref } : {}), start: body.start, end: body.end }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
