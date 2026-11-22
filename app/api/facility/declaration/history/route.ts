// API Route（薄い入口。処理は src/server/app/facility.ts）：施設の申告の 1 項目の変更の記録（新しい順。FR-188）。どのロールも読める
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { declarationHistoryQuery } from "../../../../../src/server/schemas/facility";

export const GET = route({ roles: allow("GET /api/facility/declaration/history"), query: declarationHistoryQuery }, ({ query }) => ({ rows: getApp().declarationHistory(query.item) }));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
