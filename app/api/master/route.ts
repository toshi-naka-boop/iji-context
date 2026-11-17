// API Route：区分の一覧（区分・名称・点数）。算定画面の選択肢に使う
// ?yearMonth= でその診療年月の版の点数表を返す。無ければ基準月（config/demo.json）の版。版のない年月は断る（近い版で代用しない）
import { z } from "zod";
import { period } from "../../../src/demo/period";
import { hasRevision, resolveRevision } from "../../../src/engine/revisions";
import { badRequest } from "../../../src/server/errors";
import { route } from "../../../src/server/http";
import { allow } from "../../../src/server/policy";

const masterQuery = z.strictObject({ yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

export const GET = route({ roles: allow("GET /api/master"), query: masterQuery }, ({ query }) => {
  const yearMonth = query.yearMonth ?? period.yearMonth;
  if (!hasRevision(yearMonth)) throw badRequest(`診療年月に当たる版がない: ${yearMonth}`);
  return Object.entries(resolveRevision(yearMonth).points).map(([kubun, d]) => ({ kubun, name: d.name, points: d.points }));
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
