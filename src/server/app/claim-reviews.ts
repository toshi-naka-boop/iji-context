// 取り込んだレセプトの点検で、本人が「この請求の点検を確かめた」を押した記録（design.md §14-3「レベルで線を引く」・段 17g。L-123）。
// 実在用のクリニック（tenants.kind = real）でだけ、F10 の処理件数に数える。デモ・未定のクリニックは今のまま（練習問題で数える）。役割では分けない（C-184）。
// 同じ請求・同じ本人は 1 件だけ。指摘の数や結果では数えない。本人の分だけを返し、他人の件数・記録は返さない（FR-16）
import { badRequest } from "../errors";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export function createClaimReviews(ctx: AppContext, clock: Clock) {
  const { sqlite, kind } = ctx;
  /** 本人が確かめた請求の件数（実在用のクリニックだけ。ほかは 0） */
  const countOf = (clerkId: string): number => (kind === "real" ? (sqlite.prepare("SELECT count(*) AS n FROM claim_reviews WHERE clerk_id = ?").get(clerkId) as { n: number }).n : 0);
  /** 本人がその請求を確かめた時刻（まだなら null）。実在用のクリニックでないときは undefined（画面はボタンを出さない） */
  function reviewedOf(claimId: string, clerkId?: string): { at: string } | null | undefined {
    if (kind !== "real" || !clerkId) return undefined;
    const r = sqlite.prepare("SELECT reviewed_at FROM claim_reviews WHERE claim_id = ? AND clerk_id = ?").get(claimId, clerkId) as { reviewed_at: string } | undefined;
    return r ? { at: r.reviewed_at } : null;
  }
  /**
   * 「この請求の点検を確かめた」。checked は、その請求の取り込んだレセプトの点検ができたか（読めない・版のないレセプトは点検していないので数えない）。
   * 同じ請求・同じ本人の 2 回目は、前の記録のまま（件数は増えない）。added は、この押下で件数が増えたか
   */
  function review(claimId: string, clerkId: string, checked: boolean): { added: boolean; at: string } {
    if (kind !== "real") throw badRequest("「この請求の点検を確かめた」は、実在のデータで使うクリニックで数えます（デモでは練習問題で数えます）");
    if (!checked) throw badRequest("点検できていないレセプトです（読めない・診療年月の版がないレセプトは、確かめたとして数えません）");
    const added = sqlite.prepare("INSERT OR IGNORE INTO claim_reviews (claim_id, clerk_id, reviewed_at) VALUES (?, ?, ?)").run(claimId, clerkId, clock.now()).changes > 0;
    return { added, at: reviewedOf(claimId, clerkId)!.at };
  }
  return { countOf, reviewedOf, review };
}

export type ClaimReviews = ReturnType<typeof createClaimReviews>;
