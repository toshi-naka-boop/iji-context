// メンター同士の問い（ベテラン本人の回答）の入力
import { z } from "zod";

/** 問いの id（src/server/app/peer.ts の newPeerId が作る形。知識の slug のもとになる） */
export const peerParams = z.strictObject({ id: z.string().regex(/^P\d{4,8}$/) });
// 空白だけの回答の文言は peerAnswerByHuman が持つ
export const peerAnswerBody = z.strictObject({ answer: z.string().max(4000) });
