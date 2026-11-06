// API Route（薄い入口。処理は src/server/app.ts）：選択モードの問題一覧（GET）と、本人が選んだものの正誤（POST）
import { body, handle } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => getApp().choices((await ctx.params).id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const b = await body<{ lineIndex: number; option: string }>(req);
    return getApp().pick((await ctx.params).id, b.lineIndex, b.option);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
