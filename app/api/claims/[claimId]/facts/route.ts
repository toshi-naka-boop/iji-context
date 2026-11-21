// API Route（薄い入口。処理は src/server/app/claim-facts.ts）：請求ごとに確かめた事実の一覧（GET）と保存（POST）。確かめた人はセッションの本人。
// 医師あての事実は医師の役割だけ、医療事務あての事実は事務・ベテランだけが残せる（処理の中で分ける）。監査ログの対象は請求 id と事実のキーだけ（値は入れない）。
// 背反の特例条件の例外の問いの答え（haihan:*）も同じ入口。答えを書く関数が、ほかの key も書く・取り消すとき（共有の事実 sameDayOushinAfterVisit と haihan:*）は、
// その key ごとに監査ログの行を 1 行ずつ足す（対象は「請求 id と key」。1 行にまとめると対象の長さの上限で切れる。design.md §13-3。X-105・round-36 C-142・round-38 X-112）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimFactBody, claimParams } from "../../../../../src/server/schemas/patients";

const ACTION = "POST /api/claims/[claimId]/facts";

export const GET = route({ roles: allow("GET /api/claims/[claimId]/facts"), params: claimParams }, ({ params }) => getApp().claimFacts(params.claimId));

export const POST = route(
  { roles: allow("POST /api/claims/[claimId]/facts"), params: claimParams, body: claimFactBody, audit: { target: ({ body, params }) => `${params.claimId} ${body.fact.key}` } },
  ({ params, body: { fact }, clerkId, user }) => {
    const app = getApp();
    let others: string[] = [];
    const out = app.saveClaimFact(params.claimId, clerkId, user.role, { key: fact.key, date: fact.date, value: fact.value, source: fact.source }, (keys) => (others = keys));
    // 書けたときだけ、ほかに書いた・取り消した key の行を足す（この要求の行は、route が処理の後に残す）
    for (const key of others) app.audit.record({ userId: user.id, role: user.role, action: ACTION, target: `${params.claimId} ${key}`, result: "ok", status: 200, demoNow: app.now() });
    return out;
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
