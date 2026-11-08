// API Route：練習問題の今の状態（医師確認の状態・照合の不一致が残っているか）
import { authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().drillState((await ctx.params).id));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
