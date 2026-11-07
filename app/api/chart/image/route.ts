// API Route（薄い入口。処理は src/server/instance.ts）。電子カルテの画面を撮った画像から、病名・診療記録・処方を書き写す（保存はしない）
import { body, authed } from "../../../../src/server/http";
import { readChartFromImage } from "../../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => readChartFromImage(Buffer.from(String((await body<{ imageBase64: string }>(req)).imageBase64 ?? ""), "base64")));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
