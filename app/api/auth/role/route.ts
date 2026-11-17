// API Route：自分の役割を切り替える（spec FR-144）。1 人で使っているクリニックの持ち主だけ。
// 切替は tenant の監査ログ（ルートヘルパが自動で残す）と、auth.db の auth_events の両方に残る
import { route } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { roleBody } from "../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/auth/role"), body: roleBody, audit: { target: ({ body }) => body.role } }, ({ user, body, ip }) => {
  const next = getAuth().switchRole(user, body.role);
  getAuth().recordEvent({ event: `role.switch:${user.role}>${next.role}`, result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return { role: next.role };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
