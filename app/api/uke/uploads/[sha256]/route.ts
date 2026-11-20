// API Route（薄い入口。処理は src/server/app/erase.ts）。取り込んだファイルを消す（design.md §11-11）。事務長とベテランだけ。
// 消すのは、原本と、そのファイルの請求にぶら下がる記録。監査ログの対象は内容のハッシュだけ（氏名・番号・請求の中身は入れない）。
// 返すのは消した件数だけ（一覧は返さない。一覧は GET /api/uke で取り直す）
import { route } from "../../../../../src/server/http";
import { deleteUkeUpload } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { uploadParams } from "../../../../../src/server/schemas/cases";

export const DELETE = route({ roles: allow("DELETE /api/uke/uploads/[sha256]"), params: uploadParams, audit: { target: ({ params }) => params.sha256 } }, ({ params }) => deleteUkeUpload(params.sha256));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
