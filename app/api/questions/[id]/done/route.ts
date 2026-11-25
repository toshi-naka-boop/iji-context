// API Route（薄い入口。処理は src/server/app.ts）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { questionParams } from "../../../../../src/server/schemas/questions";

export const POST = route({ roles: allow("POST /api/questions/[id]/done"), params: questionParams }, ({ params, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().done(params.id);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
