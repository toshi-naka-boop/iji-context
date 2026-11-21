// API Route（薄い入口。処理は src/server/app/local-pairs.ts）：「この請求のこの組が返戻・査定された」（design.md §14-4）。
// その組の承認済みの allow の院内の知識を要再検証にし、その請求で押した事実（local:*）を取り消す。権限は請求ごとの事実の入力と同じ（医療事務あて）。
// 監査ログの対象は請求 id と組。取り消した押した事実の key は、key ごとに 1 行ずつ足す（事実の入力と同じ。本文は入れない）
import { auditKeyOf } from "../../../../../src/generic/local-pair";
import { forbidden } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimParams } from "../../../../../src/server/schemas/patients";
import { localReturnBody } from "../../../../../src/server/schemas/knowledge";

const ACTION = "POST /api/claims/[claimId]/local-return";

export const POST = route({ roles: allow("POST /api/claims/[claimId]/local-return"), params: claimParams, body: localReturnBody, audit: { target: ({ body, params }) => `${params.claimId} ${body.a}:${body.b}:${body.tani}` } }, ({ params, body, clerkId, user }) => {
  if (user.role === "doctor") throw forbidden("これは医療事務が確かめる項目です。事務・ベテランの役割で残します");
  const app = getApp();
  const out = app.localReturn(params.claimId, clerkId, body);
  for (const key of out.cleared) app.audit.record({ userId: user.id, role: user.role, action: ACTION, target: `${params.claimId} ${auditKeyOf(key)}`, result: "ok", status: 200, demoNow: app.now() });
  return out;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
