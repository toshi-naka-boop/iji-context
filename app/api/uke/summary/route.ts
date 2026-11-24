// API Route（薄い入口。処理は src/server/app/uke-summary.ts）。取り込んだレセプトの全件を、点検の結果の件数つきで返す（採点 r1 医療事務課長 P1-1）。読むだけで、何も記録しない
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/uke/summary") }, ({ clerkId }) => getApp().ukeSummary(clerkId));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
