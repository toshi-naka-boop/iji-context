// API Route：公的文書の条件に当たるかを人が確かめる（design.md §11-3）。「当たる」：この知識が当たる請求の中に、その文書の条件の請求がある
// 誰に許すかは権限表の行で決める（ここに役割の分岐は書かない）。監査ログの対象は知識の id と文書の id（結果は操作の名前で分かる）
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { knowledgeParams, officialCheckBody } from "../../../../../../src/server/schemas/knowledge";

export const POST = route(
  { roles: allow("POST /api/knowledge/[id]/official-check/applies"), params: knowledgeParams, body: officialCheckBody, audit: { target: ({ body, params }) => `${params.id} ${body.docId}` } },
  ({ params, body, user, clerkId }) => getApp().checkOfficial(params.id, body, true, { by: clerkId, actor: user.role }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
