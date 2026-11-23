// API Route（薄い入口。処理は src/server/app/review.ts）。取り込んだ査定・返戻の CSV を消す（FR-168 と同じ単位。spec FR-202 の I-1）。事務長とベテランだけ。
// 明細と判定も一緒に消える。監査ログの対象は内容のハッシュだけ。返すのは消した件数だけ
import { route } from "../../../../../src/server/http";
import { getApp } from "../../../../../src/server/instance";
import { allow } from "../../../../../src/server/policy";
import { uploadParams } from "../../../../../src/server/schemas/cases";

export const DELETE = route({ roles: allow("DELETE /api/review/uploads/[sha256]"), params: uploadParams, audit: { target: ({ params }) => params.sha256 } }, ({ params }) => getApp().deleteReviewUpload(params.sha256));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
