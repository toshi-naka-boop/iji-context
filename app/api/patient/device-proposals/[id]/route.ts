// API Route（薄い入口。処理は src/server/app/devices.ts）。電子カルテからの機器の変える案に「入れる／入れない」を答える（design.md §16-5・16-7。段 19e）。
// 入れると機器の行を追記する（出どころ「電子カルテ（確かめた）」）。C150 の案は測定回数の区分と患者の区分がないと 400（X-253）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { proposalBody, proposalParams } from "../../../../../src/server/schemas/patients";

// 監査ログは答えの種類だけ（機器の値は残さない）
export const POST = route({ roles: allow("POST /api/patient/device-proposals/[id]"), params: proposalParams, body: proposalBody, audit: { target: ({ body }) => body.action } }, ({ params, body, clerkId }) =>
  getApp().decideDeviceProposal(body.claimId, params.id, clerkId, {
    action: body.action,
    ...(body.kind ? { kind: body.kind } : {}),
    ...(body.fromMonth ? { fromMonth: body.fromMonth } : {}),
    ...(body.endMonth !== undefined ? { endMonth: body.endMonth } : {}),
    ...(body.c150 ? { c150: body.c150 } : {}),
  }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
