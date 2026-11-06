// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ clerkId: string; claimId: string }>(req);
    return getApp().start(b.clerkId, b.claimId);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
