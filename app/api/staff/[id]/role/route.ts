// API Route：職員の役割を変える（採点 r1 事務長 #2）。事務長とクリニックの持ち主だけ。事務長がいなくなる変更は断る。
// 監査ログの対象は職員の id だけ（役割の値は残さない）。auth.db の auth_events にも操作の名前だけを残す
import { route } from "../../../../../src/server/http";
import { getAuth, refreshClerk } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { staffParams, staffRoleBody } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/staff/[id]/role"), params: staffParams, body: staffRoleBody }, ({ user, params, body, ip }) => {
  const out = getAuth().setStaffRole(user, params.id, body.role);
  refreshClerk(params.id);
  getAuth().recordEvent({ event: "staff.role", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return out;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
