// API Route（薄い入口。処理は src/server/app/care.ts）：入所先の施設（院内の設定。design.md §18-2）の一覧（GET）と、1 つ足す・直す（POST。追記だけ）。監査ログに施設名は残さない
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { careHomeBody } from "../../../src/server/schemas/care";

export const GET = route({ roles: allow("GET /api/care-homes") }, () => ({ homes: getApp().careHomes() }));

export const POST = route({ roles: allow("POST /api/care-homes"), body: careHomeBody, audit: { target: () => "careHome" } }, ({ body, clerkId }) => ({ homes: getApp().saveCareHome(clerkId, body) }));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
