// API Route（薄い入口。処理は src/server/app.ts）：患者ごとに確かめた情報の一覧（GET）と保存（POST）
import { body, handle } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import type { PatientFactInput } from "../../../../../src/patient/facts";

export async function GET(_req: Request, ctx: { params: Promise<{ claimId: string }> }) {
  return handle(async () => getApp().patientFacts((await ctx.params).claimId));
}

export async function POST(req: Request, ctx: { params: Promise<{ claimId: string }> }) {
  return handle(async () => {
    const b = await body<{ clerkId: string; fact: PatientFactInput }>(req);
    return getApp().savePatientFact((await ctx.params).claimId, b.clerkId, b.fact);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
