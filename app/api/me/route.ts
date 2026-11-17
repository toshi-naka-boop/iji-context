// API Route（薄い入口。処理は src/server/app.ts）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { meQuery } from "../../../src/server/schemas/clerk";

/** 本人向け：自分のレベル・件数・連続正解だけ。防いだ額は optIn=1 のときだけ */
export const GET = route({ roles: allow("GET /api/me"), query: meQuery }, ({ query, clerkId }) => {
  const a = getApp();
  return { ...a.status(clerkId), prevented: a.personal(clerkId, query.optIn === "1") };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
