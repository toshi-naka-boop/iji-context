// API Route：職員を停止する（採点 r1 事務長 #2）。停止した人はログインできず、いまのセッションも消える。事務長とクリニックの持ち主だけ。
// 自分・持ち主・最後の事務長は停止できない。監査ログの対象は職員の id だけ
import { route } from "../../../../../src/server/http";
import { getAuth } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { staffParams } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/staff/[id]/suspend"), params: staffParams }, ({ user, params, ip }) => {
  const out = getAuth().setStaffDisabled(user, params.id, true);
  getAuth().recordEvent({ event: "staff.suspend", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return out;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
