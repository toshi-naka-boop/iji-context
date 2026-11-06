// API Route：F4 の照合（病名と処方の不一致）と、医師確認を送る
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

export async function GET(req: Request) {
  return handle(() => getApp().crosscheckOf(new URL(req.url).searchParams.get("claimId") ?? ""));
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ claimId: string; ruleId: string }>(req);
    return getApp().sendCrosscheck(b.claimId, b.ruleId);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
