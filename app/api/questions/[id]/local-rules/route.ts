// API Route：この請求に当てはまるローカルルール（地域・ベテランの判断・院内。FR-78）。いまの明細（lines）で当てはめる
import { notFound } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { localRulesBody, questionParams } from "../../../../../src/server/schemas/questions";

// 明細を変えるたびに画面が呼ぶ、読み取り相当の操作（何も書き換えない。本文が要るので POST にしている）。監査ログには残さない
export const POST = route({ roles: allow("POST /api/questions/[id]/local-rules"), params: questionParams, body: localRulesBody, audit: false }, ({ params, body, clerkId }) => {
  // 自分の問題だけ（同じクリニックのほかの人の問題は、ないものとして扱う）
  if (getApp().question(params.id).clerkId !== clerkId) throw notFound(`問題がない: ${params.id}`);
  return getApp().localRulesOf(params.id, body.lines);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
