// API Route：未使用の招待を取り消す（spec FR-137）。事務長と、1 人で使っているクリニックの持ち主だけ。
// 取り消すと、そのコードでは登録できなくなる。使用済みは 409、ほかのクリニックの招待は 404。
// 取り消しは tenant の監査ログ（ルートヘルパが自動で残す。対象は招待の id）と、auth.db の auth_events の両方に残る
import { route } from "../../../../../src/server/http";
import { getAuth } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { inviteParams } from "../../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/invites/[id]/revoke"), params: inviteParams }, ({ user, params, ip }) => {
  const revoked = getAuth().revokeInvite(user, params.id);
  getAuth().recordEvent({ event: `invite.revoke:${revoked.role}`, result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return { id: revoked.id };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
