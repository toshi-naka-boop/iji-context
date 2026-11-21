// API Route（薄い入口。処理は src/server/app/facility.ts）：施設の設定（FR-148）。事務長だけ。監査ログの対象は項目の名前（値は入れない）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { facilityBody } from "../../../src/server/schemas/facility";

export const GET = route({ roles: allow("GET /api/facility") }, () => getApp().facilitySettings());

export const POST = route({ roles: allow("POST /api/facility"), body: facilityBody, audit: { target: ({ body }) => body.key } }, ({ body }) => getApp().saveFacility(body.key, body.value));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
