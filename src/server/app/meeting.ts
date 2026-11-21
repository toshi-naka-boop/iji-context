// 提出結果の取り込みとレセメン会議
import { importResult, type SubmissionResult } from "../../lifecycle/applications";
import { answerItem, buildDigest, meetingReview } from "../../lifecycle/review";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export function createMeeting(ctx: AppContext, clock: Clock) {
  const { db, deps } = ctx;
  const { now } = clock;

  const importClaimResult = (r: SubmissionResult) => importResult(db, r, now());
  const agenda = () => buildDigest(deps);
  /** fix は、背反の組の知識を回答 2 で直すときの、修正版の向きと条件の文（design.md §14-1） */
  const answerAgenda = (itemId: string, answer: 1 | 2 | 3 | 4, freeText?: string, fix?: { polarity?: "allow" | "avoid"; conditionNote?: string }) => answerItem(deps, { itemId, answer, freeText, ...fix }, now());
  const runMeeting = () => meetingReview(deps, now());

  return { importClaimResult, agenda, answerAgenda, runMeeting };
}

export type Meeting = ReturnType<typeof createMeeting>;
