// API Route（薄い入口。処理は src/server/instance.ts）。本人がメンターのキャラを選ぶ（FR-19）
import { body, authed } from "../../../src/server/http";
import type { Style } from "../../../src/mentor/style";
import { chooseMentor, chooseStyle, mentorChoice, ME } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => mentorChoice(ME));
}

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ clerkId: string; characterId?: string; style?: Style }>(req);
    // style だけ送られたら伝え方のタイプ（FR-20）、characterId ならキャラ（FR-19）
    return b.style ? chooseStyle(ME, b.style) : chooseMentor(ME, b.characterId ?? "");
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
