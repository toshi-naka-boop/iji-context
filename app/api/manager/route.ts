// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { managerQuery } from "../../../src/server/schemas/manager";

/** 事務長向けの集計（個人別には分けない）。事務長ロールだけ。?month=YYYY-MM でその月に確定した分、省けば全期間の累計 */
export const GET = route({ roles: allow("GET /api/manager"), query: managerQuery }, ({ query }) => getApp().manager(query.month));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
