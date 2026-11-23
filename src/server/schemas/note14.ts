// 注14 の計算の道具の入力（design.md §15-13。段 17i）。数は 0 以上の整数、null は空の欄（0 と数えない）
import { z } from "zod";

const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
const count = z.number().int().min(0).max(10_000_000).nullable();

export const note14Query = z.strictObject({ month: ym.optional() });

/**
 * 結果を残す（POST /api/note14/worksheets）。months は期間の月ごとに、本人が「この月は全患者分を取り込んだ」を確かめたか（confirmed）と手入力の回数。
 * 確かめた月は、サーバーが数えた自動の数を使う（送られた数は使わない）。確かめていない月は手入力の数だけを使う（L-134）
 */
export const note14WorksheetBody = z.strictObject({
  checkMonth: ym,
  stage1: z.strictObject({
    months: z.array(z.strictObject({ month: ym, confirmed: z.boolean(), kou: count, otsuExtra: count })).max(12),
    gansou: count,
    secondPatient: count,
    special: z.enum(["none", "some", "unknown"]),
    // count＝C001 の行の回数（U-27 の甲）、otsuExtra＝C001-2 の行などの回数（読み乙だけで足す。省けば空の欄。round-61 C-361）
    institutions: z.array(z.strictObject({ openedOn: day.nullable(), ownerChangedFrom: day.nullable(), count, otsuExtra: count.optional() })).max(30),
    // 開設日（期間の初めより後に開設したときだけ。U-34 は門にも掛ける。round-61 C-360）
    openedOn: day.nullable().optional(),
  }),
  // 2 段目（段 17j）：欄の鍵 → 数。鍵は readings.ts の fieldKeys のものだけ（サーバーが確かめる）
  stage2: z
    .strictObject({
      values: z.record(z.string().max(80), count),
      // 欄ごとの出どころの印（段 17k。auto＝下書きのまま）。サーバーが下書きと照らして決め直す
      sources: z.record(z.string().max(80), z.enum(["auto", "manual"])).optional(),
    })
    .optional(),
});
export type Note14WorksheetBody = z.infer<typeof note14WorksheetBody>;

export const note14IdParams = z.strictObject({ id: z.coerce.number().int().positive() });
