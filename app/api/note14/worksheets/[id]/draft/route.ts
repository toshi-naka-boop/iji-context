// API Route（薄い入口。処理は src/server/app/note14.ts）：道具の結果から、申告 note14 の下書きの値を返す（design.md §15-13。L-132）。
// 申告は書かない（申告の画面が値を入れた状態で開き、本人が確かめて残す）。決めきれない・確認月以外の結果は 409
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { note14IdParams } from "../../../../../../src/server/schemas/note14";

export const GET = route({ roles: allow("GET /api/note14/worksheets/[id]/draft"), params: note14IdParams }, ({ params }) => getApp().note14Draft(params.id));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
