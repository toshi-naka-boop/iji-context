// API Route（薄い入口。処理は src/server/instance.ts）。初回のあいさつで本人が決めた名前を保存する（FR-27）。名前は監査ログに入れない
import { route } from "../../../../src/server/http";
import { setClerkName } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { nameBody } from "../../../../src/server/schemas/clerk";

export const POST = route({ roles: allow("POST /api/clerk/name"), body: nameBody }, ({ body, clerkId }) => setClerkName(clerkId, body.name));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
