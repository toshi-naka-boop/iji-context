// 知識（一覧・検証・共感・提案）と、査定・返戻の通知の入力。検証した人の名前は受け取らない（セッションの本人が監査ログに残る）
import { z } from "zod";
import { LAYER_SLUG } from "../../lifecycle/layers";

/**
 * 知識の id（src/lifecycle/store.ts の createKnowledge が作る「層/slug」の形）。knowledge/ の下のディレクトリ名になるので、
 * 層は決まった 4 つ、slug は英小文字・数字・ハイフンだけに絞る（.. や 2 つ目の / を通さない）
 */
export const knowledgeId = z.string().regex(new RegExp(`^(${Object.values(LAYER_SLUG).join("|")})/[a-z0-9-]{1,60}$`));

export const knowledgeQuery = z.strictObject({ view: z.enum(["queue"]).optional() });

// 要約・本文が空白だけのときの文言は propose（src/server/app/knowledge.ts）が持つ。要約は propose が 200 文字に切る
export const knowledgeBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("verify"), id: knowledgeId, approve: z.boolean(), reason: z.string().max(500).optional() }),
  z.strictObject({ action: z.literal("empathy"), id: knowledgeId }),
  z.strictObject({ action: z.literal("propose"), summary: z.string().max(1024), body: z.string().max(4000), relatesTo: knowledgeId.nullable().optional() }),
]);

/** 通知の PDF の上限（5MB）と、それを base64 で包んだ JSON の本文の上限 */
export const NOTICE_MAX_BYTES = 5 * 1024 * 1024;
export const NOTICE_BODY_BYTES = Math.ceil(NOTICE_MAX_BYTES / 3) * 4 + 4096;

/** 通知のファイル名の上限（字）。知識の本文（出典）に入るので短くする */
export const NOTICE_FILE_NAME_MAX = 100;
/** 知識の本文（出典）に入れるファイル名：100 字まで。制御文字・改行・パスの区切りは通さない */
const fileName = z.string().min(1).max(NOTICE_FILE_NAME_MAX).regex(/^[^\u0000-\u001f\u007f/\\]+$/);
// PDF かどうか・大きさの確かめと文言はルート（app/api/notice/route.ts）が持つ。
// ここで受けるファイル名は利用者の手元の名前そのままなので長さだけを見て、ルートが上の形に整えてから返す
export const noticeBody = z.strictObject({ sample: z.literal(true).optional(), pdfBase64: z.string().max(NOTICE_BODY_BYTES).optional(), fileName: z.string().max(255).optional() });

/** 読み取った通知（src/notice/notice.ts の Notice）。画面が、読み取りの結果をそのまま送り返す */
const notice = z.strictObject({
  documentType: z.string().max(200),
  prefecture: z.string().max(20),
  items: z
    .array(
      z.strictObject({
        yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
        patientName: z.string().max(100),
        insurerNumber: z.string().max(20),
        itemName: z.string().max(200),
        outcome: z.enum(["査定", "返戻"]),
        reason: z.string().max(4000),
      }),
    )
    .max(200),
});
export const noticeRegisterBody = z.strictObject({ notice, index: z.number().int().min(0).max(199), reexamFiled: z.boolean().optional(), fileName });
