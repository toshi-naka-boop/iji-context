// API Route（薄い入口。処理は src/server/app/doctor-abbrevs.ts）：どの記載にも結び付かない略語の扱い（算定に関係なし・医師に聞く）を選ぶ（FR-211。plan-fr211.md「規則の作り直し」4・「作り直しの補い」C-652）。
// GET は、その月にその語が出ているカルテの一覧（そのカルテのその語を含む文つき）。POST は、一覧で並んでいたカルテにまとめて選ぶ（保存はカルテと語の組）。
// 選ぶまで、そのカルテは確かめ済みにならない。監査ログの対象は診療年月と選んだカルテの数だけ
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { abbrevChoiceBody, abbrevChoiceQuery } from "../../../../src/server/schemas/chart";

export const GET = route({ roles: allow("GET /api/chart/abbrev-choices"), query: abbrevChoiceQuery }, ({ query, clerkId }) => getApp().abbrevChoiceList(clerkId, query.yearMonth, query.token));

export const POST = route({ roles: allow("POST /api/chart/abbrev-choices"), body: abbrevChoiceBody, audit: { target: ({ body }) => `${body.yearMonth} ${body.noteIds.length}件` } }, ({ body, clerkId }) =>
  getApp().chooseAbbrev(clerkId, { yearMonth: body.yearMonth, token: body.token, noteIds: body.noteIds.map(Number), choice: body.choice }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
