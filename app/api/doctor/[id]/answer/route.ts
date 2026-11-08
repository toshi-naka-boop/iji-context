// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().answerDoctor((await ctx.params).id, await body<{ option: string; freeText?: string; answeredBy: string }>(req)));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
