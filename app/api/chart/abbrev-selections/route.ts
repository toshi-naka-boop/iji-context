// API Route（薄い入口。処理は src/server/app/notes.ts の selectAbbrev）：事務がカルテの略語の扱いを選ぶ（FR-211。plan-fr211.md「辞書方式の決め」2〜4）。
// 辞書にある略語は辞書の意味・その他・判定不能、辞書にない略語は算定に関係なし・医師に聞く。カルテの確かめと月末の点検は止めない。
// 監査ログの対象はカルテの id だけ（略語・意味の文は残さない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { abbrevSelectionBody, abbrevSummaryQuery } from "../../../../src/server/schemas/doctor";

/** そのカルテの略語のまとめ（候補・選んだ扱い・医師確認中か・医師の答え）を読む。読むだけ */
export const GET = route({ roles: allow("GET /api/chart/abbrev-selections"), query: abbrevSummaryQuery }, ({ query, clerkId }) => getApp().readAbbrevSummary(clerkId, Number(query.noteId)));

export const POST = route({ roles: allow("POST /api/chart/abbrev-selections"), body: abbrevSelectionBody, audit: { target: ({ body }) => body.noteId } }, ({ body, clerkId }) =>
  getApp().selectAbbrev(clerkId, { noteId: Number(body.noteId), token: body.token, option: body.option, ...(body.meaning !== undefined ? { meaning: body.meaning } : {}), ...(body.askDoctor !== undefined ? { askDoctor: body.askDoctor } : {}) }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
