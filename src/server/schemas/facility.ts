// 施設の設定の入力（FR-148）：1 項目ずつ。値の型は項目ごと。null は「分からない」。
// 施設の種別・注16・DX・ベースアップは施設の申告（FR-188。design.md §15-2）に移したので、ここでは受け取らない
import { z } from "zod";
import { isRealDate } from "../../engine/rules/util";
import { GRADE_CHOICES } from "../../facility/codes";
import { NOTE14_OVERRIDE_REASONS } from "../../facility/note14";
import { centiOf, OXYGEN_BASES, OXYGEN_KINDS } from "../../facility/oxygen";

const yesNo = z.boolean().nullable();

export const facilityBody = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("priceResponse"), value: yesNo }),
  z.strictObject({ key: z.literal("revisitBaseUpSameDay"), value: yesNo }),
  z.strictObject({ key: z.literal("revisitPriceSameDay"), value: yesNo }),
]);

/** 日付（"YYYY-MM-DD"。暦にない日は断る）。null は空 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // 暦にない日（13 月・2 月 30 日）は、例外を投げずに検証の失敗（400）にする（反証 round-94 X-474）
  .refine(isRealDate)
  .nullable();
const requirement = z.enum(["met", "not_met", "unknown"]);
/** いつの診療月から（"YYYY-MM"。どの項目のどの行にも必須。P-2）。空・ない値は 400 */
const fromMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const checked = { fromMonth, checkedOn: day, recheckOn: day };

/** 施設の申告の 1 項目（POST /api/facility/declaration）。項目の鍵で形が分かれる */
export const declarationBody = z.union([
  z.strictObject({ item: z.literal("grade"), choice: z.enum(["unknown", ...GRADE_CHOICES.map((g) => g.id)] as [string, ...string[]]), requirement, startOn: day, notifiedOn: day, ...checked }),
  z.strictObject({ item: z.literal("note16"), requirement, ...checked }),
  z.strictObject({ item: z.literal("dispensing"), choice: z.enum(["outside", "inside", "unknown"]), ...checked }),
  // 同じ建物で同じ月に 2 人以上を診ている建物があるか（段 17f。C-242）
  z.strictObject({ item: z.literal("building"), choice: z.enum(["none", "some", "unknown"]), ...checked }),
  // 注14（段 17h）：結果の側の三値。届出日・算定開始年月日は「減算」のときだけの任意の記録（判定に使わない）。
  // override は、道具の結果（減算になる）と違う「通常」を残すときの理由と確認月（L-160。理由のない送信はサーバーが 400 で断る）
  z.strictObject({
    item: z.literal("note14"),
    choice: z.enum(["normal", "reduced", "unknown"]),
    notifiedOn: day,
    startOn: day,
    override: z.strictObject({ reason: z.enum(Object.keys(NOTE14_OVERRIDE_REASONS) as [keyof typeof NOTE14_OVERRIDE_REASONS, ...(keyof typeof NOTE14_OVERRIDE_REASONS)[]]), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).optional(),
    ...checked,
  }),
  z.strictObject({ item: z.string().regex(/^code:\d{1,4}$/), notified: z.enum(["yes", "no", "unknown"]), requirement, startOn: day, notifiedOn: day, choice: z.enum(["1", "2"]).nullable(), ...checked }),
]);

/** まとめて「変わりなし」（POST /api/facility/declaration/confirm）：選んだ申告の行の id */
export const confirmBody = z.strictObject({ ids: z.array(z.number().int().positive()).min(1).max(200) });

/** まとめて「変わりなし」の初期の選択の問い（GET /api/facility/declaration/confirm）：知らせの行（notice）か、判定の画面の理由（month・item） */
export const confirmQuery = z.union([
  z.strictObject({ notice: z.coerce.number().int().positive() }),
  z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), item: z.string().regex(/^(grade|note16|dispensing|building|note14|code:\d{1,4})$/).optional() }),
]);

/** 変更の記録の問い（GET /api/facility/declaration/history?item=） */
export const declarationHistoryQuery = z.strictObject({ item: z.string().regex(/^(grade|note16|dispensing|building|note14|code:\d{1,4})$/) });

/**
 * 届け出た酸素の単価の 1 行（POST /api/facility/oxygen-prices。design.md §19-3）：足すか、取り消すか。
 * 単価は 0 より大きく小数第 2 位まで（文字で受ける。0.01 円の整数にする）。始め ≦ 終わり。上限を超える単価も入れられる（画面が「請求には上限の額を使います」と出す）
 */
export const oxygenPriceBody = z.union([
  z
    .strictObject({
      kind: z.enum(OXYGEN_KINDS),
      price: z.string().refine((s) => centiOf(s) !== null, { message: "単価は 0 より大きく、小数第 2 位までで入れてください" }),
      validFrom: day.unwrap(),
      validUntil: day.unwrap(),
      basis: z.enum(OXYGEN_BASES),
    })
    .refine((b) => b.validFrom <= b.validUntil, { message: "適用の始めは、終わりと同じ日か前にしてください", path: ["validUntil"] }),
  z.strictObject({ revokes: z.number().int().positive() }),
]);
