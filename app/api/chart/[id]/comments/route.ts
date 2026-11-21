// API Route（薄い入口。処理は src/server/app/notes.ts の saveNoteComment）：算定プレビューの「入力が要る」摘要欄の記載に値を入れる（FR-176）。
// 監査ログの対象はカルテの id だけ（値は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { noteCommentBody, noteParams } from "../../../../../src/server/schemas/chart";

export const POST = route({ roles: allow("POST /api/chart/[id]/comments"), params: noteParams, body: noteCommentBody }, ({ params, body, clerkId }) => getApp().saveNoteComment(Number(params.id), clerkId, body));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
