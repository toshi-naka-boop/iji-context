// API Route：F3 代行入力の整文 → 医師確認（必ず挟む）
import { modelFor } from "../../../src/mentor/models";
import { tidy } from "../../../src/mentor/scribe";
import { badRequest } from "../../../src/server/errors";
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { proxyBody } from "../../../src/server/schemas/proxy";

export const POST = route({ roles: allow("POST /api/proxy"), body: proxyBody, limit: "llm", audit: { target: ({ body }) => body.claimId } }, async ({ body: b }) => {
  if (!b.text.trim()) throw badRequest("下書きが空");
  // LLM を呼ぶ前に、請求があることを確かめる
  getApp().caseOf(b.claimId);
  const scribed = await tidy(b.text, modelFor("scribe"));
  return { scribed, ...getApp().proxySubmit(b.claimId, b.text, scribed) };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
