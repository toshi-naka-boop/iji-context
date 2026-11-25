// API Route：監査ログの閲覧（spec FR-140）。事務長だけ。操作の記録（tenant）と、ログインまわりの記録（このクリニックの分）を新しい順に返す
import { route } from "../../../src/server/http";
import { getApp, getAuth } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { auditQuery } from "../../../src/server/schemas/auth";

export const GET = route({ roles: allow("GET /api/audit"), query: auditQuery }, ({ user, query }) => ({
  log: getApp().audit.list(query.limit ?? 100),
  auth: getAuth().eventsOf(user.tenantId, query.limit ?? 100),
}));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
