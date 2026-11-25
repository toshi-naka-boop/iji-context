// API Route：医師確認の練習問題から、医師確認を送る（FR-76。質問は決まった形で、7 要件の検査を通る）
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { questionParams } from "../../../../../src/server/schemas/questions";

export const POST = route({ roles: allow("POST /api/questions/[id]/ask-doctor"), params: questionParams }, ({ params, clerkId }) => {
  // 自分の問題からだけ送れる（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().askDoctorForDrill(params.id);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
