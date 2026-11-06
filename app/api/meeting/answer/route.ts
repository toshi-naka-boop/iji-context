// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ itemId: string; answer: 1 | 2 | 3 | 4; freeText?: string }>(req);
    return getApp().answerAgenda(b.itemId, b.answer, b.freeText);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
