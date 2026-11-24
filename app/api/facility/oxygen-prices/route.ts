// API Route（薄い入口。処理は src/server/app/oxygen.ts）：届け出た酸素の単価（任意。design.md §19-3・§19-8）。
// 読むのはどのロールも、入れる・取り消すのは施設の申告と同じ役割（事務長と責任者）。監査ログには、入れた・取り消したことと区分だけを残す（単価は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { oxygenPriceBody } from "../../../../src/server/schemas/facility";

export const GET = route({ roles: allow("GET /api/facility/oxygen-prices") }, () => getApp().oxygenPrices());

export const POST = route(
  { roles: allow("POST /api/facility/oxygen-prices"), body: oxygenPriceBody, audit: { target: ({ body }) => ("revokes" in body ? `oxygenPrice:取り消し:${getApp().oxygenPriceKindOf(body.revokes) ?? "?"}` : `oxygenPrice:入れた:${body.kind}`) } },
  ({ clerkId, body }) => getApp().saveOxygenPrice(clerkId, body),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
