// API Route（薄い入口。処理は src/server/instance.ts）。電子カルテの画面を撮った画像から、病名・診療記録・処方を書き写す（保存はしない）。
// LLM を呼ぶので、利用者ごとの回数制限を付ける（FR-139）
import { imageTypeOf, MAX_IMAGE_BYTES } from "../../../../src/chart/image";
import { badRequest } from "../../../../src/server/errors";
import { route } from "../../../../src/server/http";
import { readChartFromImage } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { imageBody, MAX_IMAGE_BASE64 } from "../../../../src/server/schemas/chart";

/** 本文は base64 の画像（5MB の 4/3 倍）と JSON の枠の分まで読む。それを超えたら読まずに 413 */
export const POST = route({ roles: allow("POST /api/chart/image"), body: imageBody, maxBytes: MAX_IMAGE_BASE64 + 1024, limit: "llm" }, ({ body, user }) => {
  const image = Buffer.from(body.imageBase64, "base64");
  // 画像の検査（大きさ・先頭のバイト列）は LLM を呼ぶ前にここでも行い、利用者に文言を返す
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) throw badRequest("画像が空か、5MB を超えています");
  if (!imageTypeOf(image)) throw badRequest("PNG・JPEG・WebP の画像を選んでください");
  return readChartFromImage(user, image);
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
