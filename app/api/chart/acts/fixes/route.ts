// API Route（薄い入口。処理は src/server/app/notes.ts）。確かめたあとで、処方の日の「確かめた」の印と、当てられない行為の「同じ／違う」を付け直す一覧（design.md §16-4-1・16-3・16-7。C-441）。読むだけ
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { devicesQuery } from "../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/chart/acts/fixes"), query: devicesQuery }, async ({ query, clerkId }) => {
  // 印の効く日を決めるため、その請求の構造化データを接続先から読んでから並べる（C-440）
  await getApp().ensureStructured(query.claimId);
  return getApp().confirmedFixes(query.claimId, clerkId);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
