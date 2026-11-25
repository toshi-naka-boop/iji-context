// API Route：査定・返戻の通知（PDF）を Claude に読ませ、決まった規則で対応づけた結果を返す（まだ何も登録しない）。
// LLM を呼ぶので、利用者ごとの回数制限を付ける（FR-139）。PDF は base64 で受けるので、本文の上限は 5MB の PDF が入る大きさにする。
// 見本（合成の K6 の査定通知）を読むのは、デモのクリニックだけ（実在・未定のクリニックには作り物を見せない。2026-11-22 利用者の判断）
import { readFileSync } from "node:fs";
import path from "node:path";
import { modelFor } from "../../../src/mentor/models";
import { readNotice } from "../../../src/notice/notice";
import { SAMPLE_NOTICE_BASE } from "../../../src/notice/sample";
import { badRequest } from "../../../src/server/errors";
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { NOTICE_BODY_BYTES, NOTICE_FILE_NAME_MAX, NOTICE_MAX_BYTES, noticeBody } from "../../../src/server/schemas/knowledge";

const SAMPLE = `${SAMPLE_NOTICE_BASE}.pdf`;

export const POST = route({ roles: allow("POST /api/notice"), body: noticeBody, limit: "llm", maxBytes: NOTICE_BODY_BYTES }, async ({ body: b, user }) => {
  if (b.sample && getApp().kind !== "demo") throw badRequest("見本の通知は、デモで試すクリニックだけで読めます");
  const pdf = b.sample ? readFileSync(path.join(process.cwd(), SAMPLE)) : Buffer.from(b.pdfBase64 ?? "", "base64");
  if (pdf.length === 0 || pdf.length > NOTICE_MAX_BYTES) throw badRequest("PDF が空か、5MB を超えている");
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw badRequest("PDF ではない");
  // ファイル名は知識の本文（出典）に入る。制御文字・改行・パスの区切りを除き、長さを切ってから返す（登録のスキーマと同じ形にする）
  const cleaned = path.basename(b.fileName ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "").slice(0, NOTICE_FILE_NAME_MAX);
  const fileName = b.sample ? path.basename(SAMPLE) : cleaned || "notice.pdf";
  const r = await readNotice(user, pdf, modelFor("notice"));
  return { fileName, notice: r.notice, items: getApp().resolveNoticeItems(r.notice), stats: r.stats };
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
