// API Route（薄い入口。処理は src/server/app/notes.ts）。事実と行ったこと（当てたコード・選んだ対応・その日の院内・院外）を、本人が確かめた 1 回の操作で保存する（FR-95・FR-192。design.md §15-6）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { actsBody } from "../../../../src/server/schemas/chart";

// 監査ログの対象はカルテの id だけ（行為の名前・引用は残さない）
export const POST = route({ roles: allow("POST /api/chart/acts"), body: actsBody, audit: { target: ({ body }) => body.noteId } }, ({ body, clerkId }) =>
  getApp().confirmActs(Number(body.noteId), clerkId, { facts: body.facts, acts: body.acts, rx: body.rx, rxChoice: body.rxChoice ?? null }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
