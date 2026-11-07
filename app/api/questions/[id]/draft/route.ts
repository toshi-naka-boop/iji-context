// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import type { ClaimContext, ClaimLine } from "../../../../../src/engine/types";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => {
    const b = await body<{ lines: ClaimLine[]; facts?: Partial<ClaimContext["facts"]> }>(req);
    return getApp().draft((await ctx.params).id, b.lines, b.facts);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
