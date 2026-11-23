// API Route（薄い入口。処理は src/server/instance.ts）。訪問カルテを書き、AI が事実を取り出す（FR-69）。LLM を呼ぶので、利用者ごとの回数制限を付ける（FR-139）
import { route } from "../../../src/server/http";
import { getApp, writeChart } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { CHART_BODY_BYTES, chartBody } from "../../../src/server/schemas/chart";

/** 書いた人はセッションの本人。監査ログの対象は請求 id だけ（カルテの本文は残さない）。本文の上限は、5 欄を上限の字数まで日本語で書いても入る大きさ */
export const POST = route({ roles: allow("POST /api/chart"), body: chartBody, maxBytes: CHART_BODY_BYTES, limit: "llm", audit: { target: ({ body }) => body.claimId } }, ({ body, clerkId, user }) =>
  writeChart({ ...body, clerkId, user }),
);

/** 訪問カルテの一覧（消す相手を選ぶため）。事務長には全部、ほかの人には自分が書いた分。本文は返さない */
export const GET = route({ roles: allow("GET /api/chart") }, ({ clerkId, user }) => getApp().listNotes(clerkId, user.role));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
