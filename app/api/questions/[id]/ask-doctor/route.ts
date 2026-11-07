// API Route：医師確認の練習問題から、医師確認を送る（FR-76。質問は決まった形で、7 要件の検査を通る）
import { authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().askDoctorForDrill((await ctx.params).id));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
