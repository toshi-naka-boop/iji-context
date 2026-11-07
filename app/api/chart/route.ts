// API Route（薄い入口。処理は src/server/instance.ts）。訪問カルテを書き、AI が事実を取り出す（FR-69）
import type { ChartNote } from "../../../src/chart/extract";
import type { VisitKind } from "../../../src/chart/notes";
import { body, authed } from "../../../src/server/http";
import { ME, writeChart } from "../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => writeChart({ ...(await body<{ claimId: string; kind: VisitKind; note: ChartNote }>(req)), clerkId: ME }));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
