// API Route（薄い入口。処理は src/server/app/notes.ts の recheckAbbrev）：確定の前に、残した記載で略語の印を判定し直す（FR-211。round-99 C-651）。
// 何も保存しない（読むだけなので監査ログにも残さない）。画面は返ってきた「どの記載にも結び付かない語」で選ぶボタンを出し直す
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { abbrevCheckBody } from "../../../../src/server/schemas/chart";

export const POST = route({ roles: allow("POST /api/chart/abbrev-check"), body: abbrevCheckBody }, ({ body, clerkId }) =>
  getApp().recheckAbbrev(Number(body.noteId), clerkId, { facts: body.facts, acts: body.acts }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
