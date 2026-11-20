// API Route（薄い入口。処理は src/server/app/uke-check.ts）。取り込んだレセプトを、選んだ版の点数表とルールで試算した結果（design.md §11-12）。
// 診療年月に版がないレセプトも読める。その場で計算して返すだけで、何も記録しない。rev は、コードの表を持つ版の id だけ（比較用の版は 400）
import { route } from "../../../../../../src/server/http";
import { getApp } from "../../../../../../src/server/instance";
import { allow } from "../../../../../../src/server/policy";
import { ukeTrialQuery } from "../../../../../../src/server/schemas/cases";
import { claimParams } from "../../../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/uke/claims/[claimId]/trial"), params: claimParams, query: ukeTrialQuery }, ({ params, query }) => getApp().ukeTrial(params.claimId, query.rev));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
