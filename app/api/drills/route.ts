// API Route（薄い入口。処理は src/practice/drills.ts）。練習問題の一覧（答えのルールは出さない。FR-75）
import { authed } from "../../../src/server/http";
import { getApp, ME } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => getApp().drills(ME));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
