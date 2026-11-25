// API Route：招待コードを作る・発行済みの招待を一覧する（spec FR-137）。事務長と、1 人で使っているクリニックの持ち主だけ。
// コードは 1 回だけ使え、期限があり、このクリニックと指定したロールで登録される。コードを返すのは作ったときの 1 回だけ（DB にはハッシュだけ）。
// 一覧はロール・期限・使用済みかだけで、コードもハッシュも返さない
import { route } from "../../../src/server/http";
import { getAuth } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { inviteBody } from "../../../src/server/schemas/auth";

export const GET = route({ roles: allow("GET /api/invites") }, ({ user }) => getAuth().listInvites(user));

export const POST = route({ roles: allow("POST /api/invites"), body: inviteBody, audit: { target: ({ body }) => body.role } }, ({ user, body, ip }) => {
  // 事務長がいないクリニックでは、事務長の招待だけを作る（事務長のいないまま 2 人目が入る罠を断る）
  getAuth().assertInviteKeepsManager(user, body.role);
  const invite = getAuth().createInvite(user, body.role);
  getAuth().recordEvent({ event: `invite.create:${body.role}`, result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return invite;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
