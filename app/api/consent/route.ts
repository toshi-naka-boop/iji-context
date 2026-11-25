// API Route：注意書きへの同意（design.md §11-11）。同意するのはセッションの本人だけ（誰の同意かを本文で受け取らない）。
// 同意は tenant の監査ログ（ルートヘルパが自動で残す。対象は注意書きの版）と、auth.db の auth_events の両方に残る
import { route } from "../../../src/server/http";
import { getAuth } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { consentBody } from "../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/consent"), body: consentBody, audit: { target: ({ body }) => body.version } }, ({ user, body, ip }) => {
  const accepted = getAuth().acceptNotice(user.id, body.version);
  getAuth().recordEvent({ event: `notice.accept:${accepted.version}`, result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  return { version: accepted.version };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
