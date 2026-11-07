// API Route（薄い入口。処理は src/server/app.ts）：選択モードの問題一覧（GET）と、本人が選んだものの正誤（POST）
import { body, authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().choices((await ctx.params).id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => {
    const b = await body<{ lineIndex: number; option: string }>(req);
    return getApp().pick((await ctx.params).id, b.lineIndex, b.option);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
