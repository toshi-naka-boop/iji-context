// 訪問カルテの入力。書いた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { FACT_KINDS } from "../../chart/extract";
import { ABBREV_CHOICES, ACT_CATEGORIES, CHILD_KINDS, MASTER_TABLES, MAX_LOOKUP, TABLE_KEYS } from "../../chart/acts";
import { YEAR_MONTH } from "../../demo/period";
import { SELECTABLE_REVISIONS } from "../../engine/revisions";
import { MAX_IMAGE_BYTES } from "../../chart/image";
import { MAX_CHART_TEXT } from "../../chart/limits";
import { claimId } from "./cases";

export { MAX_CHART_TEXT };
const field = z.string().max(MAX_CHART_TEXT);

export const chartBody = z.strictObject({
  claimId,
  kind: z.enum(["訪問診療", "往診"]),
  note: z.strictObject({ s: field, o: field, a: field, p: field, rx: field }),
});
/** 取り込んだ請求に貼るカルテ（design.md §15-9 の POST /api/uke/claims/[claimId]/notes）。日付は暦にある日で（反証 round-55 C-301）、その請求の診療年月の日（処理の中で確かめる） */
export const recordBody = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }),
  note: chartBody.shape.note,
});
/** カルテを書く本文（JSON）の上限（バイト）：5 欄 × 上限の字数 × 3 バイト（日本語の UTF-8）と、JSON の枠・改行の分 */
export const CHART_BODY_BYTES = 5 * MAX_CHART_TEXT * 3 + 4096;

/** カルテの id（chart_notes の連番） */
export const noteParams = z.strictObject({ id: z.string().regex(/^[1-9][0-9]{0,9}$/) });
/** 略語の印（FR-211）。画面が受け取った形のまま返してよいが、使わない（保存のときにサーバーが付け直す） */
const abbrev = z.array(z.string().max(100)).max(50).optional();
export const confirmBody = z.strictObject({
  facts: z.array(z.strictObject({ kind: z.enum(FACT_KINDS), value: z.string().max(200), quote: z.string().max(MAX_CHART_TEXT), abbrev })).max(50),
});

/** 行ったこと（design.md §15-6・15-7）。当てたコードは処理の中で、診療年月の 1 枚に実在するかを確かめる */
const name200 = z.string().max(200);
const lookup = z.array(z.string().max(100)).max(MAX_LOOKUP);
const actMatch = z.strictObject({ tbl: z.enum(MASTER_TABLES), code: z.string().regex(/^\d{9}$/), name: name200, by: z.enum(["name", "alias", "candidate", "search"]) }).nullable().optional();
const actChild = z.strictObject({ kind: z.enum(CHILD_KINDS), written: name200, lookup, quantity: z.string().max(100).optional(), quote: z.string().max(MAX_CHART_TEXT), match: actMatch, abbrev });
/** 本人が選んだ「同じ（ref）／違う（same: false）」の印（design.md §16-3）。処理の中で、その日の同じ種類の電子カルテの行為かを確かめる */
const ref = z.string().min(1).max(100);
const actFold = z.strictObject({ kind: z.literal("order"), ref: ref.optional(), by: z.literal("person"), same: z.literal(false).optional() }).optional();
const act = z.strictObject({ category: z.enum(ACT_CATEGORIES), written: name200, lookup, quantity: z.string().max(100).optional(), quote: z.string().max(MAX_CHART_TEXT), with: z.array(actChild).max(20).optional(), match: actMatch, fold: actFold, abbrev });
/** 事実と行ったことを、確かめた 1 回の操作で保存する本文（POST /api/chart/acts） */
export const actsBody = z.strictObject({
  noteId: noteParams.shape.id,
  facts: confirmBody.shape.facts,
  acts: z.array(act).max(100),
  rx: z.array(z.strictObject({ quote: z.string().max(MAX_CHART_TEXT) })).max(20),
  rxChoice: z.enum(["outside", "inside", "unknown"]).nullable().optional(),
  /** 「この日の院内・院外を確かめた」を押した（design.md §16-4-1。値を選び直したときは押さなくても印が付く） */
  rxConfirmed: z.boolean().optional(),
});
/**
 * 確かめて残したカルテの当てられない行為を、選んで当てる本文（POST /api/chart/acts の別の形。design.md §15-9 の「当てられない行為（候補から選ぶ入口）」。X-157）。
 * child は、その行為で使った薬・器材（with）の位置（子を当てるとき。X-161）
 */
export const pickBody = z.strictObject({
  noteId: noteParams.shape.id,
  index: z.number().int().min(0).max(99),
  child: z.number().int().min(0).max(19).optional(),
  match: z.strictObject({ tbl: z.enum(MASTER_TABLES), code: z.string().regex(/^\d{9}$/), name: name200, by: z.enum(["alias", "candidate", "search"]) }),
});
/** 確かめて残したカルテの当てられない行為に「同じ（ref）／違う／選ばない」をあとから付ける本文（POST /api/chart/acts/fold。design.md §16-7） */
export const foldBody = z.strictObject({ noteId: noteParams.shape.id, index: z.number().int().min(0).max(99), choice: z.enum(["same", "different", "none"]), ref: ref.optional() });
/** 独自コードの対応を残す本文（POST /api/code-maps。design.md §16-2・16-7）。code は当ててよい表のコード（機器は機器の種類のキー）。yearMonth の 1 枚で実在を確かめる */
export const codeMapBody = z.strictObject({ connectorId: z.string().regex(/^[a-z0-9_-]{1,40}$/), field: z.enum(["薬", "材料", "行為", "指導管理", "機器"]), extCode: z.string().min(1).max(100), code: z.string().min(1).max(20), yearMonth: z.string().regex(YEAR_MONTH) });
/** 確かめたカルテのその日の処方の欄の値と「確かめた」の印を付け直す本文（POST /api/chart/acts/rx-confirm。design.md §16-7。C-421） */
export const rxConfirmBody = z.strictObject({ noteId: noteParams.shape.id, rxChoice: z.enum(["outside", "inside", "unknown"]), confirmed: z.boolean() });
/** 医療事務が入れる訪問の時刻（POST /api/chart/structured/visit-time。design.md §16-6・16-7）。"HH:MM"。終了が開始より後かは処理の中で確かめる */
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const visitTimeBody = z.strictObject({ claimId, date: recordBody.shape.date, ref: ref.optional(), start: hhmm, end: hhmm });
/** POST /api/chart/acts の本文（確かめて保存する形か、当てられない行為を選んで当てる形） */
export const actsOrPickBody = z.union([actsBody, pickBody]);
const ym = z.string().regex(YEAR_MONTH);
/** 候補（GET /api/chart/acts/candidates）。lookup は「|」で区切った語（5 個まで） */
/** noteId・index・child は、保存したカルテの行為の位置（略語を医師に聞いた行為の候補に、医師の答えの語を使う。FR-211） */
export const candidatesQuery = z.strictObject({
  table: z.enum(TABLE_KEYS),
  ym,
  written: z.string().min(1).max(200),
  lookup: z.string().max(600).optional(),
  noteId: noteParams.shape.id.optional(),
  index: z.string().regex(/^[0-9]{1,2}$/).optional(),
  child: z.string().regex(/^[0-9]{1,2}$/).optional(),
  /** その行為の引用（確かめる画面の引き直し。引用で略語の印を決めるので、渡すと自動では当てない。反証 round-97 C-630） */
  quote: z.string().max(MAX_CHART_TEXT).optional(),
});
/** マスターを名前で探す（GET /api/masters/search） */
/** カルテの構造化データ（GET /api/chart/structured）。患者は患者マスタの id */
export const structuredQuery = z.strictObject({ patientId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), yearMonth: ym });
export const mastersSearchQuery = z.strictObject({ table: z.enum(TABLE_KEYS), ym, q: z.string().min(1).max(100) });

/** 選べる版の id（比較と試算。請求の判定に使う版と、比較用の版） */
export const revisionId = z.enum(SELECTABLE_REVISIONS.map((r) => r.id));
/** 算定プレビューの要選択への答え（pending の id → 選択肢の id）。クエリには JSON の文字列で載せる。rev を付けると、その版での試算 */
export const claimQuery = z.strictObject({ choices: z.string().max(2000).optional(), rev: revisionId.optional() });
/** 改定の比較。claimId を省くと、比べられる請求と選べる版だけを返す */
export const compareQuery = z.strictObject({ claimId: claimId.optional(), from: revisionId.optional(), to: revisionId.optional() });
export const claimChoices = z.record(z.string().max(80), z.string().max(40));

/**
 * 算定プレビューの「入力が要る」摘要欄の記載に入れる値（FR-176）。slot は導出の記載の場所（記載の表の行|導出が決めたコード|何件目）、code は 9 桁のコメントコード。
 * 値の形（コードの先頭 3 桁で決まる）は処理の中で確かめる（src/server/app/notes.ts の saveNoteComment）
 */
export const noteCommentBody = z.strictObject({
  slot: z.string().regex(/^[A-Za-z0-9-]{1,40}\|(\d{9})?\|\d{1,2}$/),
  code: z.string().regex(/^\d{9}$/),
  text: z.string().max(200),
});

/** 自由記述を SOAP に整える本文。claimId は、整形で消えた略語（FR-211）を見るための診療年月を決める（省くと見ない） */
export const soapBody = z.strictObject({ text: z.string().max(MAX_CHART_TEXT), claimId: claimId.optional() });

/** base64 にした画像の長さの上限（5MB の画像は 4/3 倍に膨らむ） */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const imageBody = z.strictObject({ imageBase64: z.string().max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
const abbrevToken = z.string().regex(/^[A-Za-z]+[0-9]*$/).max(100);
/** 結び付かない略語を選ぶ一覧（GET /api/chart/abbrev-choices。FR-211 の作り直しの補い C-652）。語は英字の略語の形だけ */
export const abbrevChoiceQuery = z.strictObject({ yearMonth: z.string().regex(YEAR_MONTH), token: abbrevToken });
/**
 * 結び付かない略語の扱いを、一覧でまとめて選ぶ本文（POST /api/chart/abbrev-choices）。noteIds は選んだときに並んでいたカルテ（効くのはそのカルテだけ）。
 * 選んだ人は受け取らない（セッションの本人から決める）
 */
export const abbrevChoiceBody = z.strictObject({ yearMonth: z.string().regex(YEAR_MONTH), token: abbrevToken, noteIds: z.array(noteParams.shape.id).min(1).max(500), choice: z.enum(ABBREV_CHOICES) });
