// API Route（薄い入口。処理は src/server/app/review.ts）。取り込んだ査定・返戻の CSV を、いまある UKE に当て直す（spec FR-202 の I-1）。人が決めた・確かめた明細は変えない
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { uploadParams } from "../../../../../../src/server/schemas/cases";

export const POST = route({ roles: allow("POST /api/review/uploads/[sha256]/rematch"), params: uploadParams, audit: { target: ({ params }) => params.sha256 } }, ({ params }) => getApp().rematchReview(params.sha256));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
