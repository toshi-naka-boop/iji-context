// API Route：練習問題の今の状態（医師確認の状態・照合の不一致が残っているか）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { questionParams } from "../../../../../src/server/schemas/questions";

export const GET = route({ roles: allow("GET /api/questions/[id]/drill"), params: questionParams }, ({ params, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().drillState(params.id);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
