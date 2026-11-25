// API Route（薄い入口。処理は src/server/app/facility.ts）：施設の申告をまとめて「変わりなし」として確かめ直す（design.md §15-2。docs M-5・X-150）。
// 残すのは事務長と責任者。監査ログの対象は行の数だけ（値は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { confirmBody, confirmQuery } from "../../../../../src/server/schemas/facility";

export const GET = route({ roles: allow("GET /api/facility/declaration/confirm"), query: confirmQuery }, ({ query }) =>
  getApp().confirmSelection("notice" in query ? { notice: query.notice } : { month: query.month, ...(query.item ? { itemKey: query.item } : {}) }),
);

export const POST = route({ roles: allow("POST /api/facility/declaration/confirm"), body: confirmBody, audit: { target: ({ body }) => `${body.ids.length} 行` } }, ({ user, body }) => getApp().confirmUnchanged(user, body.ids));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
