// API Route：職員の仮のパスワードを発行する（採点 r2 事務長 #4）。事務長とクリニックの持ち主だけ。値は、この応答で 1 回だけ返す（保存はハッシュだけ）。
// 相手のいまのセッションは消え、次のログインで自分のパスワードへの変更を求める。監査ログの対象は職員の id だけ、auth_events には操作の名前だけ（値は残さない）
import { route } from "../../../../../src/server/http";
import { getAuth } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { staffParams } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/staff/[id]/password"), params: staffParams }, ({ user, params, ip }) => {
  const out = getAuth().issueTempPassword(user, params.id);
  getAuth().recordEvent({ event: "staff.password", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return Response.json(out, { headers: { "cache-control": "no-store" } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
