// API Route（薄い入口。処理は src/server/app.ts）
import { body, handle } from "../../../src/server/http";
import type { Situation } from "../../../src/mentor/output";
import { talkToMentor } from "../../../src/server/instance";

export async function POST(req: Request) {
  return handle(async () => talkToMentor(await body<{ clerkId: string; questionId: string; message: string; situation: Situation; skipCrosscheck?: boolean }>(req)));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
