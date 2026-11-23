// API Route（薄い入口。処理は src/server/app/structured.ts）。その月のカルテの構造化データ（能力の申告・欠けの数・行・出どころの印。design.md §16-1・16-7）。
// 患者の識別子は返さない。値はログ・監査ログに出さない（読むだけなので監査ログは残さない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { structuredQuery } from "../../../../src/server/schemas/chart";

export const GET = route({ roles: allow("GET /api/chart/structured"), query: structuredQuery }, ({ query }) => getApp().chartStructured(query.patientId, query.yearMonth));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
