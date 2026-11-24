// API Route（薄い入口。処理は src/server/instance.ts）。自由に書いたカルテを SOAP の欄に整える（Haiku。保存はしない）。
// LLM を呼ぶので、利用者ごとの回数制限を付ける（FR-139）
import { badRequest } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { formatChart } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { soapBody } from "../../../../src/server/schemas/chart";

export const POST = route({ roles: allow("POST /api/chart/soap"), body: soapBody, limit: "llm" }, ({ body, user }) => {
  if (!body.text.trim()) throw badRequest("カルテが空です");
  return formatChart(user, body.text, body.claimId);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
