// 本人のこと（メンターのキャラ・伝え方・名前・自分の状況）の入力。本人の id は受け取らない（セッションから決める）
import { z } from "zod";
import { PREFERENCES, TYPES16 } from "../../mentor/style";
import { id } from "./common";

const style = z.strictObject({ preference: z.enum(PREFERENCES).optional(), type16: z.enum(TYPES16).optional() });
/** style があれば伝え方のタイプ（FR-20）、なければ characterId でキャラ（FR-19） */
export const characterBody = z.strictObject({ characterId: id.optional(), style: style.optional() });
// 名前の細かい規則と文言は cleanName（src/server/app/clerks.ts）が持つ。ここは型と長さの上限だけ
export const nameBody = z.strictObject({ name: z.string().max(64) });
export const meQuery = z.strictObject({ optIn: z.enum(["0", "1"]).optional() });
