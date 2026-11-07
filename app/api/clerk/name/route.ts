// API Route（薄い入口。処理は src/server/instance.ts）。初回のあいさつで本人が決めた名前を保存する（FR-27）
import { body, authed } from "../../../../src/server/http";
import { ME, setClerkName } from "../../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => setClerkName(ME, String((await body<{ name: string }>(req)).name ?? "")));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
