// API Route（薄い入口。処理は src/server/app.ts）：選択モードの問題一覧（GET）と、本人が選んだものの正誤（POST）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { pickBody, questionParams } from "../../../../../src/server/schemas/questions";

export const GET = route({ roles: allow("GET /api/questions/[id]/choices"), params: questionParams }, ({ params, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().choices(params.id);
});

export const POST = route({ roles: allow("POST /api/questions/[id]/choices"), params: questionParams, body: pickBody }, ({ params, body, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().pick(params.id, body.lineIndex, body.option);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
