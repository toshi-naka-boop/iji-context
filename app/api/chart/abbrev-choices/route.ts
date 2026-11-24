// API Route（薄い入口。処理は src/server/app/doctor-abbrevs.ts の chooseAbbrev）：どの記載にも結び付かない略語の扱い（算定に関係なし・医師に聞く）を、
// その月のその語の分として追記で残す（FR-211。plan-fr211.md「規則の作り直し」4）。選ぶまで、その日のカルテは確かめ済みにならない。監査ログの対象は診療年月だけ
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { abbrevChoiceBody } from "../../../../src/server/schemas/chart";

export const POST = route({ roles: allow("POST /api/chart/abbrev-choices"), body: abbrevChoiceBody, audit: { target: ({ body }) => body.yearMonth } }, ({ body, clerkId }) =>
  getApp().chooseAbbrev(clerkId, { yearMonth: body.yearMonth, token: body.token, choice: body.choice }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
