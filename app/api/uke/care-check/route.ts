// API Route（薄い入口。処理は src/server/app.ts の careCheck）：聞き取りの画面（design.md §18-5）。その診療年月の、点検の前に確かめる患者と問い。
// month を省くと、月ごとの数（確かめる患者・「見ていません」がある患者）だけ。入れるのは医療事務・ベテラン、事務長は見るだけ（入力のルートで分ける）
import { z } from "zod";
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { claimId } from "../../../../src/server/schemas/cases";

const query = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), claim: claimId.optional() });

export const GET = route({ roles: allow("GET /api/uke/care-check"), query }, ({ query }) => getApp().careCheck(query.month, query.claim));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
