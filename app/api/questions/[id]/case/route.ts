// API Route：問題の始まりの請求（訪問の時点ならその日まで、練習問題なら間違いを入れた明細）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { questionParams } from "../../../../../src/server/schemas/questions";

export const GET = route({ roles: allow("GET /api/questions/[id]/case"), params: questionParams }, ({ params, clerkId }) => {
  const a = getApp();
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  const q = a.question(params.id);
  if (q.clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return a.caseFor(q);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
