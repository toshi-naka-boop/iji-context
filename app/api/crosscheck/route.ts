// API Route：F4 の照合（病名と処方の不一致）と、医師確認を送る
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { crosscheckBody, crosscheckQuery } from "../../../src/server/schemas/cases";

export const GET = route({ roles: allow("GET /api/crosscheck"), query: crosscheckQuery }, ({ query, clerkId }) => getApp().crosscheckOf(query.claimId, query.asOf, clerkId));

export const POST = route({ roles: allow("POST /api/crosscheck"), body: crosscheckBody, audit: { target: ({ body }) => body.claimId } }, ({ body, clerkId }) =>
  getApp().sendCrosscheck(body.claimId, body.ruleId, body.asOf, clerkId),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
