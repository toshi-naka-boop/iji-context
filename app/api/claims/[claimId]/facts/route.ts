// API Route（薄い入口。処理は src/server/app/claim-facts.ts）：請求ごとに確かめた事実の一覧（GET）と保存（POST）。確かめた人はセッションの本人。
// 医師あての事実は医師の役割だけ、医療事務あての事実は事務・ベテランだけが残せる（処理の中で分ける）。監査ログの対象は請求 id と事実のキーだけ（値は入れない）。
// 背反の特例条件の例外の問いの答え（haihan:*）も同じ入口。答えを書く関数が、ほかの key も書く・取り消すとき（共有の事実 sameDayOushinAfterVisit と haihan:*）は、
// それらのキーも監査ログの対象に入れる（design.md §13-3。X-105・round-36 C-142）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimFactBody, claimParams } from "../../../../../src/server/schemas/patients";

/** 要求の本文 → 答えを書く関数が、ほかに書いた・取り消した key（監査ログの対象に足す。要求ごとに本文の物が違うので、取り違えない） */
const written = new WeakMap<object, string[]>();

export const GET = route({ roles: allow("GET /api/claims/[claimId]/facts"), params: claimParams }, ({ params }) => getApp().claimFacts(params.claimId));

export const POST = route(
  { roles: allow("POST /api/claims/[claimId]/facts"), params: claimParams, body: claimFactBody, audit: { target: ({ body, params }) => [params.claimId, body.fact.key, ...(written.get(body) ?? [])].join(" ") } },
  ({ params, body, clerkId, user }) => {
    const { fact } = body;
    return getApp().saveClaimFact(params.claimId, clerkId, user.role, { key: fact.key, date: fact.date, value: fact.value, source: fact.source }, (keys) => written.set(body, keys));
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
