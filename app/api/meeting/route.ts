// API Route（薄い入口。処理は src/server/app.ts）。議題はベテランと事務長が見られる。整理を回すのはベテラン
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/meeting") }, () => getApp().agenda());

/** 会議の整理をすぐ回す（デモ） */
export const POST = route({ roles: allow("POST /api/meeting") }, () => getApp().runMeeting());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
