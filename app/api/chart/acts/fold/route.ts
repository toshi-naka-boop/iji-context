// API Route（薄い入口。処理は src/server/app/notes.ts）。確かめて残したカルテの当てられない行為に、電子カルテの行為と「同じ／違う／選ばない」をあとから付ける（design.md §16-3・16-7。C-421）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { foldBody } from "../../../../../src/server/schemas/chart";

// 監査ログの対象はカルテの id だけ（行為の名前・電子カルテの行の値は残さない）
export const POST = route({ roles: allow("POST /api/chart/acts/fold"), body: foldBody, audit: { target: ({ body }) => body.noteId } }, ({ body, clerkId }) =>
  getApp().foldAct(Number(body.noteId), clerkId, body.index, body.choice, body.ref),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
