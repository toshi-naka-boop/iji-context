// API Route：持ち主を、同じクリニックのほかの事務長に引き継ぐ（採点 r2 事務長 #3）。持ち主だけ。本人のパスワードを入れ直して確かめる。
// 監査ログの対象は相手の職員の id だけ。auth.db の auth_events にも操作の名前と結果だけを残す（パスワードは残さない）
import { UserError } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getAuth } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { ownerTransferBody, staffParams } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/staff/[id]/owner"), params: staffParams, body: ownerTransferBody }, ({ user, params, body, ip }) => {
  try {
    const out = getAuth().transferOwner(user, params.id, body.password);
    getAuth().recordEvent({ event: "tenant.owner", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
    return out;
  } catch (e) {
    if (e instanceof UserError) getAuth().recordEvent({ event: "tenant.owner", result: "fail", userId: user.id, tenantId: user.tenantId, ip });
    throw e;
  }
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
