// 防いだ額（本人の画面と、事務長のレポート）
import { jstYearMonth } from "../../lifecycle/time";
import type { Question } from "../../practice/practice";
import { missedOf, personalView, preventedOf, summarize } from "../../prevented/prevented";
import type { ReviewReport } from "../../review/report";
import type { Doctor } from "./doctor";
import type { Questions } from "./questions";

/** 確定した月（日本時間の "YYYY-MM"）。確定していない問題は null */
const confirmedMonth = (q: Question): string | null => (q.confirmed ? jstYearMonth(q.confirmed.at) : null);

export function createPrevented(questions: Questions, doctor: Doctor, reviewReport: () => ReviewReport & { fingerprint: string }) {
  const { submitted } = questions;
  const { resolvedFields } = doctor;

  // 防いだ額は実際の請求（月末の UKE の問題）だけで数える。練習問題は数えない
  const realQuestions = (clerkId?: string) => submitted().filter((q) => !q.drill).filter((q) => !clerkId || q.clerkId === clerkId);
  const preventedItems = (clerkId?: string, month?: string) =>
    realQuestions(clerkId)
      .filter((q) => !month || confirmedMonth(q) === month)
      .flatMap((q) => preventedOf(q, resolvedFields(q.claimId)));
  const personal = (clerkId: string, optIn: boolean) => personalView(preventedItems(clerkId), optIn);
  /**
   * 事務長レポート。month（"YYYY-MM"）を渡すと、その月に確定した問題だけを数える。渡さなければ全期間の累計（採点 r2 事務長 #2）。
   * months は確定した問題のある月（新しい順。画面で選ぶ欄に出す）。
   * 見逃しは査定・返戻の突き合わせ（I-1）の判定の記録から数える。記録がなければ数えない。月では分けない（全期間）
   */
  const manager = (month?: string) => {
    const months = [...new Set(realQuestions().map(confirmedMonth).filter((m): m is string => m !== null))].sort().reverse();
    return { month: month ?? null, months, ...summarize(preventedItems(undefined, month)), 見逃し: missedOf(reviewReport()) };
  };

  return { personal, manager };
}

export type Prevented = ReturnType<typeof createPrevented>;
