// API Route（薄い入口。処理は src/server/app.ts）
import { body, authed } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
export async function GET(req: Request) {
  return authed(req, () => getApp().agenda());
}

/** 会議の整理をすぐ回す（デモ） */
export async function POST(req: Request) {
  return authed(req, () => getApp().runMeeting());
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
