// API Route（薄い入口。処理は src/server/app.ts）。LLM を呼ぶので、利用者ごとの回数制限を付ける（FR-139）
import { notFound } from "../../../src/server/errors";
import { route } from "../../../src/server/http";
import { getApp, talkToMentor } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { mentorBody } from "../../../src/server/schemas/mentor";

export const POST = route({ roles: allow("POST /api/mentor"), body: mentorBody, limit: "llm", audit: { target: ({ body }) => body.questionId } }, ({ body, clerkId }) => {
  // 自分の問題についてだけ話せる（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(body.questionId).clerkId !== clerkId) throw notFound(`問題がない: ${body.questionId}`);
  return talkToMentor({ ...body, clerkId });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
