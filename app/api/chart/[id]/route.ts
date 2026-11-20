// API Route（薄い入口。処理は src/server/app.ts）。取り出した事実を本人が確かめて確定する（FR-69）。DELETE は、そのカルテを消す（design.md §11-11）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { confirmBody, noteParams } from "../../../../src/server/schemas/chart";

// 同じクリニックのほかの人が書いたカルテも確定できる（チームで確かめる運用）。誰が確かめたかは、セッションの本人として監査ログに残る
export const POST = route({ roles: allow("POST /api/chart/[id]"), params: noteParams, body: confirmBody }, ({ params, body }) => getApp().confirmNote(Number(params.id), body.facts));

// 消せるのは、書いた本人と事務長（本人かどうかは処理の側で照合し、違えば 403）。監査ログの対象はカルテの id だけ。返すのも id だけ
export const DELETE = route({ roles: allow("DELETE /api/chart/[id]"), params: noteParams }, ({ params, clerkId, user }) => getApp().deleteNote(Number(params.id), clerkId, user.role));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
