// API Route：区分の一覧（区分・名称・点数）。算定画面の選択肢に使う
// 返すのは基準月（config/demo.json）の版の点数表
import { period } from "../../../src/demo/period";
import { resolveRevision } from "../../../src/engine/revisions";
import { route } from "../../../src/server/http";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/master") }, () =>
  Object.entries(resolveRevision(period.yearMonth).points).map(([kubun, d]) => ({ kubun, name: d.name, points: d.points })),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
