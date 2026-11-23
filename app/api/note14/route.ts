// API Route（薄い入口。処理は src/server/app/note14.ts）：注14 の計算の道具の画面（design.md §15-13）。確認月と期間・版の値・月ごとの自動の数・その確認月の結果の一覧
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { note14Query } from "../../../src/server/schemas/note14";

export const GET = route({ roles: allow("GET /api/note14"), query: note14Query }, ({ query }) => getApp().note14Tool(query.month));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
