// API Route（薄い入口。処理は src/practice/drills.ts）。練習問題の一覧（答えのルールは出さない。FR-75）
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/drills") }, ({ clerkId }) => getApp().drills(clerkId));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
