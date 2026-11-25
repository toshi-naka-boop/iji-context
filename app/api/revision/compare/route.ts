// API Route（薄い入口。処理は src/server/app.ts）。改定の比較（design.md §11-2）：同じ記録を 2 つの版で導出して並べる。読むだけで、何も記録しない
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { compareQuery } from "../../../../src/server/schemas/chart";

export const GET = route({ roles: allow("GET /api/revision/compare"), query: compareQuery }, ({ query, clerkId }) => getApp().compareOf(clerkId, query.claimId, query.from, query.to));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
