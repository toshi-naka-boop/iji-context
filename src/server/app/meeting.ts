// 提出結果の取り込みとレセメン会議
import { importResult, type SubmissionResult } from "../../lifecycle/applications";
import { answerItem, buildDigest, meetingReview } from "../../lifecycle/review";
import { submissions } from "../../db/schema";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export function createMeeting(ctx: AppContext, clock: Clock) {
  const { db, deps, hiddenClaim } = ctx;
  const { now } = clock;

  const importClaimResult = (r: SubmissionResult) => importResult(db, r, now());
  /** 会議の議題。見本の請求の提出から出た項目は、demo 以外のクリニックでは出さない（行は残す） */
  const agenda = () => {
    const d = buildDigest(deps);
    const hidden = new Set(db.select().from(submissions).all().filter((s) => hiddenClaim(s.claimId)).map((s) => s.submissionId));
    return hidden.size === 0 ? d : { ...d, items: d.items.filter((i) => !(i.submissionId && hidden.has(i.submissionId))) };
  };
  const answerAgenda = (itemId: string, answer: 1 | 2 | 3 | 4, freeText?: string) => answerItem(deps, { itemId, answer, freeText }, now());
  const runMeeting = () => meetingReview(deps, now());

  return { importClaimResult, agenda, answerAgenda, runMeeting };
}

export type Meeting = ReturnType<typeof createMeeting>;
