// 改定の比較（design.md §11-2）：同じ訪問と患者の状態を、2 つの版で導出して並べる。読むだけで、何も記録しない。
// 比べるのは、カルテ側の記録（出来事と確かめた事実）から導いた算定行。UKE の行（請求した行）ではない
import { eventsFromNotes } from "../../chart/notes";
import { compareRevisions } from "../../engine/compare";
import { manualLinesOf } from "../../engine/derive";
import { hasRevision, resolveRevision, revisionById, SELECTABLE_REVISIONS } from "../../engine/revisions";
import { badRequest } from "../errors";
import type { Cases } from "./cases";
import type { Notes } from "./notes";
import type { Uke } from "./uke";

export function createRevision(uke: Uke, casesOf: Cases, notes: Notes) {
  const { cases, caseOf } = casesOf;

  /**
   * 比べられる請求（カルテ側の記録がある請求＝同梱の症例。本人が書いて確定したカルテは、その請求に重ねる）と、選べる版。
   * claimId を渡すと、その請求の比較も返す。from を省くと選べる版の最初（いちばん古い版）、to を省くと診療年月の版
   */
  function compareOf(clerkId: string, claimId?: string, fromId?: string, toId?: string) {
    const claims = cases().filter((c) => c.recordsKnown).map((c) => ({ claimId: c.claimId, patient: uke.patientOf(c.claimId).name }));
    const revisions = SELECTABLE_REVISIONS.map((r) => ({ id: r.id, label: r.label }));
    if (claimId === undefined) return { claims, revisions, result: null };

    const base = caseOf(claimId);
    if (!base.recordsKnown) throw badRequest("カルテ側の記録がない請求は、比べられません（導出する元の記録がないため）");
    const own = hasRevision(base.yearMonth) ? resolveRevision(base.yearMonth) : undefined;
    const from = fromId === undefined ? SELECTABLE_REVISIONS[0] : revisionById(fromId);
    const to = toId === undefined ? own : revisionById(toId);
    if (!from || !to) throw badRequest("比べる版を選んでください", [from ? "to" : "from"]);
    const { events, facts } = eventsFromNotes(base.events, base.facts, notes.confirmedNotes(claimId, clerkId));
    // 手入力の行は、請求の行のうち、請求の版（なければ後の版）が導出しない区分のもの。版ごとの絞り込みは compareRevisions がする
    const manual = manualLinesOf(base.lines, own ?? to);
    const result = compareRevisions({ yearMonth: base.yearMonth, facility: base.facility, facts, events, history: base.history, manual, choices: {} }, from, to);
    return { claims, revisions, result: { claimId, yearMonth: base.yearMonth, from: { id: from.id, label: from.label }, to: { id: to.id, label: to.label }, ...result } };
  }

  return { compareOf };
}
