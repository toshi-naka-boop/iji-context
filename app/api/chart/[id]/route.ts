// API Route（薄い入口。処理は src/server/app.ts）。取り出した事実を本人が確かめて確定する（FR-69）
import type { ExtractedFact } from "../../../../src/chart/extract";
import { body, authed } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => {
    const { id } = await ctx.params;
    return getApp().confirmNote(Number(id), (await body<{ facts: ExtractedFact[] }>(req)).facts);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
