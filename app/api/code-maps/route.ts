// API Route（薄い入口。処理は src/server/app/structured.ts）。電子カルテの独自コードの対応表（design.md §16-2・16-7。段 19b）。
// GET：判定の外になった独自コードの一覧（接続先・入力欄の種類・表示名・件数。患者・日は出さない）／POST：対応を残す（入力欄の種類ごと。機器は機器の種類のキー）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { codeMapBody } from "../../../src/server/schemas/chart";

export const GET = route({ roles: allow("GET /api/code-maps") }, () => getApp().unmappedCodes());

// 監査ログはコードの鍵だけ（接続先・欄・独自コード。表示名は残さない）
export const POST = route({ roles: allow("POST /api/code-maps"), body: codeMapBody, audit: { target: ({ body }) => `${body.connectorId}:${body.field}:${body.extCode}` } }, ({ body, clerkId }) => getApp().saveCodeMap(clerkId, body));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
