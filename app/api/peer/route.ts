// API Route：メンター同士の問い（ベテラン本人に届いたもの・解決したもの）
import { handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

export async function GET() {
  return handle(() => getApp().peerList());
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
