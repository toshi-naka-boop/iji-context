// API Route：区分の一覧（区分・名称・点数）。算定画面の選択肢に使う
import { POINTS } from "../../../src/engine/points-2024";
import { handle } from "../../../src/server/http";

export async function GET() {
  return handle(() => Object.entries(POINTS).map(([kubun, d]) => ({ kubun, name: d.name, points: d.points })));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
