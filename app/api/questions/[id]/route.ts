// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().question((await ctx.params).id));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
