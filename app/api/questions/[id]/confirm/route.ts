// API Route（薄い入口。処理は src/server/app.ts）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { linesBody, questionParams } from "../../../../../src/server/schemas/questions";

export const POST = route({ roles: allow("POST /api/questions/[id]/confirm"), params: questionParams, body: linesBody }, ({ params, body, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  const q = getApp().confirm(params.id, body.lines);
  // データで動く点検（G01〜。design.md §12-5）の結果を添える。問題には保存しない（確定した判定は、今までどおり q.confirmed）
  return { ...q, generic: getApp().questionGeneric(q) };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
