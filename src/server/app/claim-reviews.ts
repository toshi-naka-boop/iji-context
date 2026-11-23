// 取り込んだレセプトの点検で、本人が「この請求の点検を確かめた」を押した記録（design.md §14-3「レベルで線を引く」・段 17g。L-123）。
// 実在用のクリニック（tenants.kind = real）でだけ、F10 の処理件数に数える。デモ・未定のクリニックは今のまま（練習問題で数える）。役割では分けない（C-184）。
// 同じ請求・同じ本人は 1 件だけ。取り込み直した同じ請求（同じ患者・同じ診療年月・同じレセプト種別。一覧の「同じ月のレセプトがすでにあります」と同じ鍵）も 1 件と数える（反証 round-55 C-304）。
// 鍵は数えるときに取り込んだレセプトから作るだけで、残さない（患者の識別子を新たに残さない・外へ出さない）。指摘の数や結果では数えない。本人の分だけを返し、他人の件数・記録は返さない（FR-16）
import { badRequest } from "../errors";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

/** keysOf：一覧にある請求 id → 同じ請求かを比べる鍵（src/server/app/uke.ts の sameMonthKey）。一覧にない請求 id は請求 id で数える */
export function createClaimReviews(ctx: AppContext, clock: Clock, keysOf: () => Map<string, string>) {
  const { sqlite, kind } = ctx;
  /** 本人が確かめた請求の件数（実在用のクリニックだけ。ほかは 0）。同じ鍵の請求は 1 件 */
  const countOf = (clerkId: string): number => {
    if (kind !== "real") return 0;
    const ids = (sqlite.prepare("SELECT claim_id FROM claim_reviews WHERE clerk_id = ?").all(clerkId) as { claim_id: string }[]).map((r) => r.claim_id);
    if (ids.length === 0) return 0;
    const keys = keysOf();
    return new Set(ids.map((id) => keys.get(id) ?? `claim:${id}`)).size;
  };
  /** 本人がその請求を確かめた時刻（まだなら null）。実在用のクリニックでないときは undefined（画面はボタンを出さない） */
  function reviewedOf(claimId: string, clerkId?: string): { at: string } | null | undefined {
    if (kind !== "real" || !clerkId) return undefined;
    const r = sqlite.prepare("SELECT reviewed_at FROM claim_reviews WHERE claim_id = ? AND clerk_id = ?").get(claimId, clerkId) as { reviewed_at: string } | undefined;
    return r ? { at: r.reviewed_at } : null;
  }
  /**
   * 「この請求の点検を確かめた」。checked は、その請求の取り込んだレセプトの点検ができたか（読めない・版のないレセプトは点検していないので数えない）。
   * 同じ請求・同じ本人の 2 回目は、前の記録のまま（件数は増えない）。取り込み直した同じ請求は記録を残すが、件数は増えない。added は、この押下で件数が増えたか
   */
  function review(claimId: string, clerkId: string, checked: boolean): { added: boolean; at: string } {
    if (kind !== "real") throw badRequest("「この請求の点検を確かめた」は、実在のデータで使うクリニックで数えます（デモでは練習問題で数えます）");
    if (!checked) throw badRequest("点検できていないレセプトです（読めない・診療年月の版がないレセプトは、確かめたとして数えません）");
    const before = countOf(clerkId);
    sqlite.prepare("INSERT OR IGNORE INTO claim_reviews (claim_id, clerk_id, reviewed_at) VALUES (?, ?, ?)").run(claimId, clerkId, clock.now());
    return { added: countOf(clerkId) > before, at: reviewedOf(claimId, clerkId)!.at };
  }
  return { countOf, reviewedOf, review };
}

export type ClaimReviews = ReturnType<typeof createClaimReviews>;
