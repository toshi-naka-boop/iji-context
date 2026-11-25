// API Route：クリニックをまるごと消す（採点 r1 事務長 #8）。クリニックの持ち主だけ。確かめに、持ち主のログイン ID とパスワードを入れる。
// クリニックの DB（監査ログを含む）も消えるので、tenant の監査ログには残さず、auth.db の auth_events に id だけを残す。消したあとは cookie を消す
import { clearCookie, route } from "../../../../src/server/http";
import { eraseTenant, getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { eraseTenantBody } from "../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/tenant/erase"), body: eraseTenantBody, audit: false }, async ({ user, body, ip }) => {
  try {
    await eraseTenant(user, body.login, body.password);
  } catch (e) {
    getAuth().recordEvent({ event: "tenant.erase", result: "fail", userId: user.id, tenantId: user.tenantId, ip });
    throw e;
  }
  getAuth().recordEvent({ event: "tenant.erase", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return Response.json({ erased: true }, { headers: { "set-cookie": clearCookie() } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
