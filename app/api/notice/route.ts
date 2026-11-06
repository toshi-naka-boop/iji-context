// API Route：査定・返戻の通知（PDF）を Claude に読ませ、決まった規則で対応づけた結果を返す（まだ何も登録しない）
import { readFileSync } from "node:fs";
import path from "node:path";
import { modelFor } from "../../../src/mentor/models";
import { readNotice } from "../../../src/notice/notice";
import { body, handle } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";

const SAMPLE = "fixtures/notices/K6-2025-02-satei.pdf";
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ sample?: boolean; pdfBase64?: string; fileName?: string }>(req);
    const pdf = b.sample ? readFileSync(path.join(process.cwd(), SAMPLE)) : Buffer.from(b.pdfBase64 ?? "", "base64");
    if (pdf.length === 0 || pdf.length > MAX_BYTES) throw new Error("PDF が空か、5MB を超えている");
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("PDF ではない");
    const fileName = b.sample ? path.basename(SAMPLE) : path.basename(b.fileName ?? "notice.pdf");
    const r = await readNotice(pdf, modelFor("notice"));
    return { fileName, notice: r.notice, items: getApp().resolveNoticeItems(r.notice), stats: r.stats };
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
