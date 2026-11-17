// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

/** 事務長向けの集計（個人別には分けない）。事務長ロールだけ */
export const GET = route({ roles: allow("GET /api/manager") }, () => getApp().manager());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
