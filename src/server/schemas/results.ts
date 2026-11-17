// 提出結果の取り込みの入力
import { z } from "zod";
import { id } from "./common";

export const resultBody = z.strictObject({
  resultId: id,
  submissionId: id,
  kind: z.enum(["原審査", "保険者再審査", "縦覧点検", "突合点検", "資格"]),
  outcome: z.enum(["通過", "返戻", "査定"]),
  kubun: z.array(id).max(50),
});
