// API Route（薄い入口。処理は src/server/instance.ts の pasteRecord）。取り込んだ請求に、日付ごとにカルテの文を貼る（design.md §15-8・§15-9。段 18c）。
// AI が行ったことを取り出すので、利用者ごとの回数制限を付ける（FR-139）。監査ログの対象は請求 id だけ（カルテの本文は残さない）
import { route } from "../../../../../../src/server/http";
import { pasteRecord } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { CHART_BODY_BYTES, recordBody } from "../../../../../../src/server/schemas/chart";
import { claimParams } from "../../../../../../src/server/schemas/patients";

export const POST = route(
  { roles: allow("POST /api/uke/claims/[claimId]/notes"), params: claimParams, body: recordBody, maxBytes: CHART_BODY_BYTES, limit: "llm", audit: { target: ({ params }) => params.claimId } },
  ({ params, body, clerkId, user }) => pasteRecord({ claimId: params.claimId, date: body.date, note: body.note, clerkId, user }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
