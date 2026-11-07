// API Route：問題の始まりの請求（訪問の時点ならその日まで、練習問題なら間違いを入れた明細）
import { authed } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async () => {
    const a = getApp();
    const q = a.question((await ctx.params).id);
    return a.caseFor(q);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
