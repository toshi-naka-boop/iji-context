// 介護保険・ほかの医療機関との調整の申告の入力（design.md §18-2。v37 21b）。形だけをここで確かめ、項目ごとの決まり（施設の有無・日付の範囲など）は src/server/app/care.ts が確かめて文言を返す
import { z } from "zod";
import { CARE_HOME_KINDS, CARE_SOURCES, KANRI_SIDES, NURSE_INSURANCES, OTHER_ACTIVITIES, OTHER_KINDS, RESIDENCE_TYPES, SHORT_STAY_KINDS, TRI } from "../../engine/care";
import { isRealDate } from "../../engine/rules/util";
import { date as dateShape } from "./cases";

/** 実在する日だけを通す（round-82 X-390） */
const date = dateShape.refine(isRealDate, { message: "実在する日付を入れてください" });

const tri = z.enum(TRI as ["はい", "いいえ", "分からない"]);
const homeId = z.string().regex(/^H[0-9a-f]{8}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const basis = { checkedOn: date, source: z.enum(CARE_SOURCES) };

const residenceValue = z.strictObject({ type: z.enum(RESIDENCE_TYPES), careHomeId: homeId.nullable().optional(), changedMidMonth: z.boolean().optional() });
const shortStayValue = z.strictObject({
  status: z.enum(["使った", "使っていない", "分からない"]),
  uses: z.array(z.strictObject({ kind: z.enum(SHORT_STAY_KINDS), start: date.nullable().optional(), end: date.nullable().optional(), careHomeId: homeId.nullable().optional(), fromDischarge: tri.optional() })).max(10).optional(),
});
const nurseValue = z.strictObject({ value: z.enum(NURSE_INSURANCES) });

/** 患者の介護の申告 1 行（答えの月は、開いた請求の診療年月。C-513） */
export const careBody = z.discriminatedUnion("item", [
  z.strictObject({ item: z.literal("residenceType"), value: residenceValue, ...basis }),
  z.strictObject({ item: z.literal("shortStay"), value: shortStayValue, ...basis }),
  z.strictObject({ item: z.literal("nurseInsurance"), value: nurseValue, ...basis }),
]);

/** ほかの機関の行（終わったら endMonth を入れた行を足す） */
export const otherBody = z.strictObject({
  instId: z.string().regex(/^I[0-9a-f]{8}$/).optional(),
  name: z.string().min(1).max(60),
  kind: z.enum(OTHER_KINDS),
  specialRelation: tri,
  kanriSide: z.enum(KANRI_SIDES),
  activities: z.partialRecord(z.enum(OTHER_ACTIVITIES), tri),
  referredOn: date.nullable().optional(),
  endMonth: month.nullable().optional(),
  ...basis,
});

/** 「ほかの機関はないと確かめた」（確かめた診療月は、開いた請求の診療年月） */
export const otherNoneBody = z.strictObject(basis);

/** 入所先の施設（院内の設定） */
export const careHomeBody = z.strictObject({
  homeId: homeId.optional(),
  name: z.string().min(1).max(60),
  kind: z.enum(CARE_HOME_KINDS),
  placedPhysician: tri,
  mitoriFacility: tri,
  recheckOn: date,
  ...basis,
});
