// API Route（薄い入口。処理は src/server/app/uke.ts）。見本の UKE（合成データ・架空コード）のダウンロード（spec FR-109）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { ukeBody } from "../../../../src/server/schemas/cases";

export const GET = route({ roles: allow("GET /api/uke/sample"), query: ukeBody }, ({ query }) => {
  const { name, bytes } = getApp().sampleUke(query.name);
  // ファイル名は、見本の一覧にある名前（利用者が送った文字列そのものではない）
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
