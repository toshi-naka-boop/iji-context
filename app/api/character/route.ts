// API Route（薄い入口。処理は src/server/instance.ts）。本人がメンターのキャラを選ぶ（FR-19）。本人はセッションから決める
import { route } from "../../../src/server/http";
import { chooseMentor, chooseStyle, mentorChoice } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { characterBody } from "../../../src/server/schemas/clerk";

export const GET = route({ roles: allow("GET /api/character") }, ({ clerkId }) => mentorChoice(clerkId));

// style だけ送られたら伝え方のタイプ（FR-20）、characterId ならキャラ（FR-19）
export const POST = route({ roles: allow("POST /api/character"), body: characterBody, audit: { target: ({ body }) => body.characterId } }, ({ body, clerkId }) =>
  body.style ? chooseStyle(clerkId, body.style) : chooseMentor(clerkId, body.characterId ?? ""),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
