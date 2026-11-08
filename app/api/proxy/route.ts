// API Route：F3 代行入力の整文 → 医師確認（必ず挟む）
import { modelFor } from "../../../src/mentor/models";
import { tidy } from "../../../src/mentor/scribe";
import { body, authed } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ claimId: string; text: string }>(req);
    if (!b.text?.trim()) throw new Error("下書きが空");
    const scribed = await tidy(b.text, modelFor("scribe"));
    return { scribed, ...getApp().proxySubmit(b.claimId, b.text, scribed) };
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
