// API Route（薄い入口。処理は src/server/app.ts）。議題に答えるのはベテラン。監査ログの対象は議題の項目の id（自由記述は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { meetingAnswerBody } from "../../../../src/server/schemas/meeting";

export const POST = route({ roles: allow("POST /api/meeting/answer"), body: meetingAnswerBody, audit: { target: ({ body }) => body.itemId } }, ({ body }) =>
  getApp().answerAgenda(body.itemId, body.answer, body.freeText),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
