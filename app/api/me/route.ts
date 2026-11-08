// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";
/** 本人向け：自分のレベル・件数・連続正解だけ。防いだ額は optIn=1 のときだけ */
export async function GET(req: Request) {
  return authed(req, () => {
    const u = new URL(req.url);
    const clerkId = ME;
    const a = getApp();
    return { ...a.status(clerkId), prevented: a.personal(clerkId, u.searchParams.get("optIn") === "1") };
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
