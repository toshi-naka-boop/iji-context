// レセメン会議の入力。回答した人の名前は受け取らない（セッションの本人が監査ログに残る）
import { z } from "zod";

/** 議題の項目の id（src/lifecycle/review.ts が作る、ハッシュの先頭 16 桁） */
export const agendaItemId = z.string().regex(/^[0-9a-f]{16}$/);
export const meetingAnswerBody = z.strictObject({
  itemId: agendaItemId,
  answer: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  freeText: z.string().max(2000).optional(),
});
