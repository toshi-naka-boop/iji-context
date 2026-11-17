// API Route（薄い入口。処理は src/server/app.ts）
import { notFound } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { questionParams } from "../../../../src/server/schemas/questions";

export const GET = route({ roles: allow("GET /api/questions/[id]"), params: questionParams }, ({ params, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  const q = getApp().question(params.id);
  if (q.clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return q;
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
