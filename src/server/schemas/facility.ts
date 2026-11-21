// 施設の設定の入力（FR-148）：1 項目ずつ。値の型は項目ごと。null は「分からない」
import { z } from "zod";
import { BASE_UPS, DX_TIERS } from "../../engine/facility";

const yesNo = z.boolean().nullable();

export const facilityBody = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("dxTier"), value: z.enum(DX_TIERS).nullable() }),
  z.strictObject({ key: z.literal("baseUp"), value: z.enum(BASE_UPS).nullable() }),
  z.strictObject({ key: z.literal("priceResponse"), value: yesNo }),
  z.strictObject({ key: z.literal("note16Met"), value: yesNo }),
  z.strictObject({ key: z.literal("revisitBaseUpSameDay"), value: yesNo }),
  z.strictObject({ key: z.literal("revisitPriceSameDay"), value: yesNo }),
]);
