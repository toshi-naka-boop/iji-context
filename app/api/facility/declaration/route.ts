// API Route（薄い入口。処理は src/server/app/facility.ts）：施設の申告（FR-188〜191。design.md §15-2・§15-9）。
// 読むのはどのロールも（医療事務が指摘の根拠を見られるように）。残すのは事務長と責任者（ベテラン）。監査ログの対象は項目の鍵だけ（値は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import type { DeclarationBody } from "../../../../src/server/app/facility";
import { declarationBody } from "../../../../src/server/schemas/facility";

export const GET = route({ roles: allow("GET /api/facility/declaration") }, () => getApp().declarations());

export const POST = route({ roles: allow("POST /api/facility/declaration"), body: declarationBody, audit: { target: ({ body }) => body.item } }, ({ user, body }) => getApp().saveDeclaration(user, body as DeclarationBody));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
