// API Route（薄い入口。処理は src/server/app/uke.ts）。UKE のアップロード（spec FR-106〜109）
// 受け取るのは、架空コードだけで作られた合成データ。条件を 1 つでも満たさないファイルは、ファイルごと断る
import { badRequest, UserError } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { UKE_LIMITS } from "../../../../src/uke/limits";

/** multipart/form-data の file（UKE）→ 取り込んだあとの一覧。上限を超える本文は、読み切る前に断る */
export const POST = route({ roles: allow("POST /api/uke/upload"), form: { maxBytes: UKE_LIMITS.maxBytes + 4096 }, limit: "upload" }, async ({ form, clerkId }) => {
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) throw badRequest("UKE のファイルを選んでください");
  if (file.size > UKE_LIMITS.maxBytes) throw new UserError(413, "送られた内容が大きすぎます");
  return getApp().uploadUke(clerkId, Buffer.from(await file.arrayBuffer()));
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
