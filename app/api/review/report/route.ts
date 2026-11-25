// API Route（薄い入口。処理は src/server/app/review.ts）。査定・返戻の突き合わせの報告（spec FR-202 の I-1）：件数だけ。割合は出さない
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/review/report") }, () => getApp().reviewReport());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
