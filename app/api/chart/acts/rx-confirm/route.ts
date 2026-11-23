// API Route（薄い入口。処理は src/server/app/notes.ts）。確かめたカルテのその日の処方の欄の値と「確かめた」の印を付け直す（design.md §16-4-1・16-7。C-421）
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { rxConfirmBody } from "../../../../../src/server/schemas/chart";

// 監査ログの対象はカルテの id だけ（処方の文・値は残さない）
export const POST = route({ roles: allow("POST /api/chart/acts/rx-confirm"), body: rxConfirmBody, audit: { target: ({ body }) => body.noteId } }, ({ body, clerkId }) =>
  getApp().confirmRx(Number(body.noteId), clerkId, { rxChoice: body.rxChoice, confirmed: body.confirmed }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
