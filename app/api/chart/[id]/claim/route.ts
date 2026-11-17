// API Route（薄い入口。処理は src/server/app.ts）。確定したカルテから導出した算定行・根拠・保留・指摘を返す（FR-94〜102）。読むだけで、何も記録しない
import { badRequest } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { claimChoices, claimQuery, noteParams } from "../../../../../src/server/schemas/chart";

/** 要選択への答えは保存せず、画面が持っている分をクエリで受ける */
function choicesOf(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  try {
    return claimChoices.parse(JSON.parse(raw));
  } catch {
    throw badRequest("入力が正しくありません（項目：choices）", ["choices"]);
  }
}

export const GET = route({ roles: allow("GET /api/chart/[id]/claim"), params: noteParams, query: claimQuery }, ({ params, query }) => getApp().chartClaim(Number(params.id), choicesOf(query.choices)));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
