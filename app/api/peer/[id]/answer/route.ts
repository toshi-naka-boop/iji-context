// API Route：ベテラン本人の回答（知識候補になる）。答えるのはベテランロールの本人。監査ログの対象は問いの id（回答の本文は入れない）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { peerAnswerBody, peerParams } from "../../../../../src/server/schemas/peer";

export const POST = route({ roles: allow("POST /api/peer/[id]/answer"), params: peerParams, body: peerAnswerBody }, ({ params, body }) =>
  getApp().peerAnswerByHuman(params.id, body.answer),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
