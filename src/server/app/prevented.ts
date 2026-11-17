// 防いだ額（本人の画面と、事務長のレポート）
import { managerReport, personalView, preventedOf } from "../../prevented/prevented";
import type { Doctor } from "./doctor";
import type { Questions } from "./questions";

export function createPrevented(questions: Questions, doctor: Doctor) {
  const { submitted } = questions;
  const { resolvedFields } = doctor;

  // 防いだ額は実際の請求（月末の UKE の問題）だけで数える。練習問題は数えない
  const preventedItems = (clerkId?: string) =>
    submitted().filter((q) => !q.drill)
      .filter((q) => !clerkId || q.clerkId === clerkId)
      .flatMap((q) => preventedOf(q, resolvedFields(q.claimId)));
  const personal = (clerkId: string, optIn: boolean) => personalView(preventedItems(clerkId), optIn);
  const manager = () => managerReport(preventedItems(), []);

  return { personal, manager };
}

export type Prevented = ReturnType<typeof createPrevented>;
