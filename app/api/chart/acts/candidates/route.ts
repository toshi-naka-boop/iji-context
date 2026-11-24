// API Route（薄い入口。処理は src/chart/match.ts）。書かれた名前と lookup の語から、診療年月の 1 枚に実在するコードだけを候補に並べる（design.md §15-7。20 件まで）。読むだけ
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { candidatesQuery } from "../../../../../src/server/schemas/chart";

// 書かれた名前（カルテの語）を受け取るので、監査ログ・ログには値を出さない
export const GET = route({ roles: allow("GET /api/chart/acts/candidates"), query: candidatesQuery }, ({ query }) =>
  getApp().actCandidates(
    query.table,
    query.ym,
    query.written,
    (query.lookup ?? "").split("|").filter(Boolean),
    query.noteId && query.index ? { noteId: Number(query.noteId), index: Number(query.index), ...(query.child ? { child: Number(query.child) } : {}) } : undefined,
  ),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
