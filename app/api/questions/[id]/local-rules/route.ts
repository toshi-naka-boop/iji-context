// API Route：この請求に当てはまるローカルルール（地域・ベテランの判断・院内。FR-78）。いまの明細（lines）で当てはめる
import type { ClaimLine } from "../../../../../src/engine/types";
import { authed, body } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().localRulesOf((await ctx.params).id, (await body<{ lines?: ClaimLine[] }>(req)).lines));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
