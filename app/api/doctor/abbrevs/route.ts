// API Route（薄い入口。処理は src/server/app/doctor-abbrevs.ts）：略語の医師への確認（FR-211）。問いの一覧（GET）と答え（POST）。医師の役割だけ。
// 監査ログの対象は診療年月と記載の数だけ（語・引用・答えの文は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { doctorAbbrevBody } from "../../../../src/server/schemas/doctor";

export const GET = route({ roles: allow("GET /api/doctor/abbrevs") }, () => getApp().doctorAbbrevs());

export const POST = route({ roles: allow("POST /api/doctor/abbrevs"), body: doctorAbbrevBody, audit: { target: ({ body }) => `${body.yearMonth} ${body.refs.length}件` } }, ({ body, clerkId }) =>
  getApp().answerDoctorAbbrev(clerkId, { yearMonth: body.yearMonth, token: body.token, refs: body.refs, option: body.option, freeText: body.freeText }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
