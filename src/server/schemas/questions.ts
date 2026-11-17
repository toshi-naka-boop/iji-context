// 処理体験（1 件＝1 問）の入力。画面（app/work/page.tsx）が送る形だけを受ける
import { z } from "zod";

/** 問題の id（src/server/app/questions.ts の start が作る形：q0001） */
const questionId = z.string().regex(/^q\d{4,9}$/);
/** 請求の id（症例-診療年月：K1-2025-03） */
const claimId = z.string().regex(/^K\d{1,3}-\d{4}-\d{2}$/);
/** 練習問題の id（src/practice/drills.ts の d00、doctor-drills.ts の m01） */
const drillId = z.string().regex(/^[dm]\d{2}$/);
/** 日付（YYYY-MM-DD） */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 区分（src/engine/points-2024.ts のキーの形） */
const kubun = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);

/** 明細の 1 行（src/engine/types.ts の ClaimLine） */
const line = z.strictObject({ kubun, count: z.number().int().min(0).max(999), dates: z.array(date).max(31) });
const lines = z.array(line).max(100);

export const questionParams = z.strictObject({ id: questionId });
/** 問題を始める。drill があれば練習問題（どの請求かは問題が決める） */
export const startBody = z.strictObject({ claimId, mode: z.enum(["通常", "選択"]).optional(), asOf: date.optional(), drill: drillId.optional() });
/** 下書きを確かめる・確定する */
export const linesBody = z.strictObject({ lines });
/** 当てはまるローカルルール（lines がなければ問題の始まりの明細で当てはめる） */
export const localRulesBody = z.strictObject({ lines: lines.optional() });
/** 選択モードで 1 つ選ぶ（option は区分か「なし」「判定不能」） */
export const pickBody = z.strictObject({ lineIndex: z.number().int().min(0).max(99), option: z.string().min(1).max(40) });
