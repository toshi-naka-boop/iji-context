// API Route（薄い入口。処理は src/server/instance.ts）。自由に書いたカルテを SOAP の欄に整える（Haiku。保存はしない）
import { body, authed } from "../../../../src/server/http";
import { formatChart } from "../../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => formatChart(String((await body<{ text: string }>(req)).text ?? "").slice(0, 4000)));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
