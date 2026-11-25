// API Route（薄い入口。処理は src/server/app/premise-checks.ts）：条件つきの指摘の「前提を確かめた」を残す・取り消す（採点 r4 医療事務課長 P1-1）。
// outcome が null なら取り消す。監査ログには請求 id と指摘の鍵（ルール・行やコード。患者の識別子を含まない）を残す
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { claimParams, premiseCheckBody } from "../../../../../../src/server/schemas/patients";

export const POST = route({ roles: allow("POST /api/uke/claims/[claimId]/premise"), params: claimParams, body: premiseCheckBody, audit: { target: ({ params, body }) => `${params.claimId}|${body.key}` } }, ({ params, body, clerkId }) => getApp().savePremiseCheck(params.claimId, clerkId, body.key, body.outcome));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
