// メンターに話しかける入力
import { z } from "zod";
import { id } from "./common";

export const mentorBody = z.strictObject({
  questionId: id,
  message: z.string().min(1).max(2000),
  situation: z.enum(["新人の誤り", "カルテ不足", "審査が難しい", "正方向", "通常"]),
  skipCrosscheck: z.boolean().optional(),
  /** 聞いている画面。uke＝取り込んだレセプトの点検の画面（その画面の指摘をメンターに渡す。採点 r3 医療事務課長 #2） */
  screen: z.enum(["uke"]).optional(),
});
