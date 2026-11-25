// API Route（薄い入口。処理は src/chart/match.ts）。基本マスターを名前で探す（design.md §15-7。名称の部分一致で 20 件まで。表・コード・名称だけ）。読むだけ
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { mastersSearchQuery } from "../../../../src/server/schemas/chart";

export const GET = route({ roles: allow("GET /api/masters/search"), query: mastersSearchQuery }, ({ query }) => getApp().searchMasters(query.table, query.ym, query.q));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
