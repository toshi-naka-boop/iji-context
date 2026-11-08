// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../src/server/http";
import type { Situation } from "../../../src/mentor/output";
import { ME, talkToMentor } from "../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => talkToMentor({ ...(await body<{ questionId: string; message: string; situation: Situation; skipCrosscheck?: boolean }>(req)), clerkId: ME }));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
