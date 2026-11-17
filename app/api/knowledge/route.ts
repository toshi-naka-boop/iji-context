// API Route：知識の一覧・検証キュー・検証・共感・提案（F5・F11）。
// 閲覧・提案・共感はどのロールにも開く（可視性にゲートを置かない）。検証（承認・却下）だけベテランに限る
import { forbidden } from "../../../src/server/errors";
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { ROLE_LABELS } from "../../../src/server/roles";
import { knowledgeBody, knowledgeQuery } from "../../../src/server/schemas/knowledge";

export const GET = route({ roles: allow("GET /api/knowledge"), query: knowledgeQuery }, ({ query }) => (query.view === "queue" ? getApp().queue() : getApp().knowledgeList()));

// 監査ログの対象は知識の id（提案は、直す先の知識があればその id）。要約・本文・却下の理由は入れない
export const POST = route({ roles: allow("POST /api/knowledge"), body: knowledgeBody, audit: { target: ({ body }) => (body.action === "propose" ? body.relatesTo : body.id) } }, ({ body, user }) => {
  const a = getApp();
  if (body.action === "verify") {
    // 検証する人の名前は受け取らない。誰が検証したかは、セッションの本人として監査ログに残る
    if (user.role !== "veteran") throw forbidden(`この操作は「${ROLE_LABELS.veteran}」の役割で行います（いまの役割：${ROLE_LABELS[user.role]}）`);
    return a.verify(body.id, body.approve, body.reason);
  }
  if (body.action === "empathy") return a.empathize(body.id);
  return a.propose(body);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
