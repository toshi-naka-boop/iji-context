// 取り込んだレセプトの点検の、条件つきの指摘の「前提を確かめた」（採点 r4 医療事務課長 P1-1）。
// 医療事務が前提を確かめた条件つきの指摘は、全件の一覧の「残り」から外す。確定の指摘は、確かめても外さない（直すのが筋）。
// 記録はクリニックで 1 つ（誰が確かめても、課長・事務長の一覧に同じく効く）。追記だけで、請求と指摘の鍵ごとに、いちばん新しい行が効く。
// 取り消しは cleared の行を足して表す（誰がいつ確かめ、誰がいつ取り消したかが残る）。指摘の鍵は src/uke/premise.ts
import { conditionalKeysOf, type PremiseOutcome } from "../../uke/premise";
import { badRequest } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { UkeCheck } from "./uke-check";

export type PremiseCheck = { key: string; outcome: PremiseOutcome; by: string; at: string };
type Row = { finding_key: string; outcome: string; checked_by: string; checked_at: string };

export function createPremiseChecks(ctx: AppContext, clock: Clock, clerks: Clerks) {
  const { sqlite } = ctx;
  /** その請求で、いま効いている確かめ（取り消したものは除く）。by は確かめた人の名前 */
  function premiseChecksOf(claimId: string): PremiseCheck[] {
    const rows = sqlite.prepare("SELECT finding_key, outcome, checked_by, checked_at FROM finding_checks WHERE id IN (SELECT MAX(id) FROM finding_checks WHERE claim_id = ? GROUP BY finding_key) ORDER BY id").all(claimId) as Row[];
    const nameOf = (id: string) => {
      try {
        return clerks.clerk(id).name;
      } catch {
        return "（いない職員）";
      }
    };
    return rows.filter((r) => r.outcome !== "cleared").map((r) => ({ key: r.finding_key, outcome: r.outcome as PremiseOutcome, by: nameOf(r.checked_by), at: r.checked_at }));
  }
  /**
   * 「前提を確かめた」を残す（outcome が null なら取り消す）。check は、その請求の今の点検の結果（読めない・版のないレセプトは行を持たない）。
   * 鍵は、いま出ている条件つきの指摘のものだけ受け取る（確定の指摘・出ていない指摘は断る）
   */
  function savePremiseCheck(claimId: string, clerkId: string, key: string, outcome: PremiseOutcome | null, check: ReturnType<UkeCheck["ukeCheck"]>) {
    if (!("rows" in check)) throw badRequest("点検できていないレセプトです（読めない・診療年月の版がないレセプトには、条件つきの指摘がありません）");
    const keys = conditionalKeysOf(check);
    if (!keys.includes(key)) throw badRequest("この請求の条件つきの指摘ではありません（確定の指摘は、確かめただけでは残りから外しません。直してください）", ["key"]);
    sqlite.prepare("INSERT INTO finding_checks (claim_id, finding_key, outcome, checked_by, checked_at) VALUES (?, ?, ?, ?, ?)").run(claimId, key, outcome ?? "cleared", clerkId, clock.now());
    return { premiseChecks: premiseChecksOf(claimId) };
  }
  return { premiseChecksOf, savePremiseCheck };
}

export type PremiseChecks = ReturnType<typeof createPremiseChecks>;
