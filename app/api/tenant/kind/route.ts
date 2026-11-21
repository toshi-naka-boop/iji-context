// API Route：使い方が未定のクリニックの種類（デモで試す／実在のデータで使う）を一度だけ選ぶ（2026-11-22 利用者の判断）。
// 事務長と、1 人で使っているクリニックの持ち主だけ。選んだあとは変えられない。選んだら、開いているクリニックを開き直す（種類で振る舞いが変わるため）
import { route } from "../../../../src/server/http";
import { getAuth, reopenTenant } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { tenantKindBody } from "../../../../src/server/schemas/auth";

export const POST = route({ roles: allow("POST /api/tenant/kind"), body: tenantKindBody, audit: { target: ({ body }) => body.kind } }, ({ user, body, ip }) => {
  const kind = getAuth().chooseKind(user, body.kind);
  getAuth().recordEvent({ event: `tenant.kind:${kind}`, result: "ok", userId: user.id, tenantId: user.tenantId, ip });
  reopenTenant(user.tenantId);
  return { kind };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
