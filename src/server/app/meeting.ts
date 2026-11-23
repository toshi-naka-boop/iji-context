// 提出結果の取り込みとレセメン会議
import { importResult, type SubmissionResult } from "../../lifecycle/applications";
import { answerItem, buildDigest, meetingReview, recount } from "../../lifecycle/review";
import { listKnowledge } from "../../lifecycle/store";
import { submissions } from "../../db/schema";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export function createMeeting(ctx: AppContext, clock: Clock) {
  const { db, deps, hiddenClaim } = ctx;
  const { now } = clock;

  const importClaimResult = (r: SubmissionResult) => importResult(db, r, now());
  /**
   * 会議の議題。見本の請求の提出から出た項目は、demo 以外のクリニックでは出さない（行は残す）。
   * 提出は、項目の submissionId（ignored）と、理由の misses（miss。submissionId は null）の両方を見る
   */
  const agenda = () => {
    const d = buildDigest(deps);
    const hidden = new Set(db.select().from(submissions).all().filter((s) => hiddenClaim(s.claimId)).map((s) => s.submissionId));
    if (hidden.size === 0) return d;
    const touches = (i: (typeof d.items)[number]) => (i.submissionId !== null && hidden.has(i.submissionId)) || (i.reason.kind === "miss" && i.reason.misses.some((m) => hidden.has(m.submissionId)));
    return { ...d, items: d.items.filter((i) => !touches(i)) };
  };
  /** 知識の当たり・外れを数え直す（整理の手順 1 と同じ。使わない請求の提出を外した数にする。real を選んだ直後に呼ぶ） */
  const recountKnowledge = () => {
    for (const m of listKnowledge(deps.store)) recount(deps, m.id);
  };
  /** fix は、背反の組の知識を回答 2 で直すときの、修正版の向きと条件の文（design.md §14-1） */
  const answerAgenda = (itemId: string, answer: 1 | 2 | 3 | 4, freeText?: string, fix?: { polarity?: "allow" | "avoid"; conditionNote?: string }) => answerItem(deps, { itemId, answer, freeText, ...fix }, now());
  const runMeeting = () => meetingReview(deps, now());

  return { importClaimResult, agenda, answerAgenda, runMeeting, recountKnowledge };
}

export type Meeting = ReturnType<typeof createMeeting>;
