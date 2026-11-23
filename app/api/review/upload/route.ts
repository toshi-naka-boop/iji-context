// API Route（薄い入口。処理は src/server/app/review.ts）。増減点連絡書・返戻内訳書の CSV の取り込み（spec FR-202 の I-1）。
// 審査支払機関と処理年月はファイル名から読むので、ファイル名もそのまま受け取る。監査ログには内容のハッシュも氏名も入れない（操作の名前だけ）
import { badRequest, UserError } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { REVIEW_MAX_BYTES } from "../../../../src/review/format";

export const POST = route({ roles: allow("POST /api/review/upload"), form: { maxBytes: REVIEW_MAX_BYTES + 4096 } }, async ({ form, clerkId }) => {
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw badRequest("CSV のファイルを選んでください");
  if (file.size > REVIEW_MAX_BYTES) throw new UserError(413, "送られた内容が大きすぎます");
  return getApp().importReview(clerkId, file.name, Buffer.from(await file.arrayBuffer()));
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
