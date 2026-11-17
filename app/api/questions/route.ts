// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { startBody } from "../../../src/server/schemas/questions";

export const POST = route({ roles: allow("POST /api/questions"), body: startBody, audit: { target: ({ body }) => body.drill ?? body.claimId } }, ({ body, clerkId }) => {
  // 練習問題（FR-75）は問題の id だけで始める（どの請求かは問題が決める）
  if (body.drill) return getApp().startDrill(clerkId, body.drill);
  return getApp().start(clerkId, body.claimId, body.mode, body.asOf);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
