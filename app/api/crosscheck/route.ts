// API Route：F4 の照合（病名と処方の不一致）と、医師確認を送る
import { body, authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";

export async function GET(req: Request) {
  const u = new URL(req.url);
  return authed(req, () => getApp().crosscheckOf(u.searchParams.get("claimId") ?? "", u.searchParams.get("asOf") ?? undefined, ME));
}

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ claimId: string; ruleId: string; asOf?: string; clerkId?: string }>(req);
    return getApp().sendCrosscheck(b.claimId, b.ruleId, b.asOf, ME);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
