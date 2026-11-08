// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";
export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ claimId: string; mode?: "通常" | "選択"; asOf?: string; drill?: string }>(req);
    // 練習問題（FR-75）は問題の id だけで始める（どの請求かは問題が決める）
    if (b.drill) return getApp().startDrill(ME, b.drill);
    return getApp().start(ME, b.claimId, b.mode, b.asOf);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
