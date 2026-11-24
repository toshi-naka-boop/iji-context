// 防いだ額（本人の画面と、事務長のレポート）
import { missedOf, personalView, preventedOf, summarize } from "../../prevented/prevented";
import type { ReviewReport } from "../../review/report";
import type { Doctor } from "./doctor";
import type { Questions } from "./questions";

export function createPrevented(questions: Questions, doctor: Doctor, reviewReport: () => ReviewReport & { fingerprint: string }) {
  const { submitted } = questions;
  const { resolvedFields } = doctor;

  // 防いだ額は実際の請求（月末の UKE の問題）だけで数える。練習問題は数えない
  const preventedItems = (clerkId?: string) =>
    submitted().filter((q) => !q.drill)
      .filter((q) => !clerkId || q.clerkId === clerkId)
      .flatMap((q) => preventedOf(q, resolvedFields(q.claimId)));
  const personal = (clerkId: string, optIn: boolean) => personalView(preventedItems(clerkId), optIn);
  // 見逃しは査定・返戻の突き合わせ（I-1）の判定の記録から数える。記録がなければ数えない
  const manager = () => ({ ...summarize(preventedItems()), 見逃し: missedOf(reviewReport()) });

  return { personal, manager };
}

export type Prevented = ReturnType<typeof createPrevented>;
