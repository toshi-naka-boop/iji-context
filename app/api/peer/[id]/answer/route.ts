// API Route：ベテラン本人の回答（知識候補になる）
import { body, authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => getApp().peerAnswerByHuman((await ctx.params).id, (await body<{ answer: string }>(req)).answer));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
