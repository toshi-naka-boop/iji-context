// API Route：停止した職員を再開する（採点 r1 事務長 #2）。事務長とクリニックの持ち主だけ。監査ログの対象は職員の id だけ
import { route } from "../../../../../src/server/http";
import { getAuth } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { staffParams } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/staff/[id]/resume"), params: staffParams }, ({ user, params, ip }) => {
  const out = getAuth().setStaffDisabled(user, params.id, false);
  getAuth().recordEvent({ event: "staff.resume", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return out;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
