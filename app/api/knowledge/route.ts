// API Route：知識の一覧・検証キュー・検証・共感・提案（F5・F11）
import { body, authed } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

export async function GET(req: Request) {
  return authed(req, () => (new URL(req.url).searchParams.get("view") === "queue" ? getApp().queue() : getApp().knowledgeList()));
}

type Action =
  | { action: "verify"; id: string; approve: boolean; reason?: string }
  | { action: "empathy"; id: string }
  | { action: "propose"; summary: string; body: string; relatesTo?: string | null };

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<Action>(req);
    const a = getApp();
    if (b.action === "verify") return a.verify(b.id, b.approve, b.reason);
    if (b.action === "empathy") return a.empathize(b.id);
    if (b.action === "propose") return a.propose(b);
    throw new Error("不明な操作");
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
