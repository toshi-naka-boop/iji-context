// 設計 v36 の新しい点検の件数（design.md §17-6 の 6。scripts/count-kisai.ts が使う）。件数だけを返し、中身・氏名・番号・コードの値は返さない。
// 画面の上限（FINDING_LIMIT）で切られた指摘ではなく、G07 が出した全部を数える（X-323）。G07 の準備ができていない DB では、記載の形だけを数える（evaluateGeneric と同じ。§17-3）。
// 手書きのルールとの重なりは、取り込んだレセプトの点検（src/server/app/uke-check.ts）と同じ作り方で通す（同梱の施設の設定・事実はどれも不明・出来事なし・カルテ側の記録なし）。
// 診療年月に版がない請求は、手書きのルールを掛けず、その診療年月を含む版（比べの版を含む）の世代でデータの点検だけを掛ける
import facilityJson from "../../config/facility.json";
import { evaluate } from "../engine";
import { facilityOf, type FacilityJson } from "../engine/facility";
import { hasRevision, resolveRevision, SELECTABLE_REVISIONS } from "../engine/revisions";
import type { ClaimContext } from "../engine/types";
import { checkReady, pickSnapshot, type MastersDb } from "../masters/db";
import type { UkeParsed } from "../uke/types";
import { mapClaim, withCommentLines } from "../uke/uke";
import { conditionalOf, g07, g07FormOnly, kisaiOf } from "./g07";
import { mappedLinesOf, overlap } from "./overlap";
import type { GenericAboutMore, GenericFinding } from "./types";

export type KisaiCount = { claims: number; unreadable: number; noRevision: number; noTable: number; form: number; formDay00: number; formFuture: number; missing03: number; conditional: number; hiddenR17: number; hiddenPresent: number; formDuplicate: number };

export function countKisai(files: UkeParsed[], db: MastersDb): KisaiCount {
  const facility = facilityOf(facilityJson as FacilityJson);
  const unknown = new Proxy({}, { get: () => ({ known: false }) }) as ClaimContext["facts"];
  const ready = checkReady(db, "G07")?.ready === true;
  const total: KisaiCount = { claims: 0, unreadable: 0, noRevision: 0, noTable: 0, form: 0, formDay00: 0, formFuture: 0, missing03: 0, conditional: 0, hiddenR17: 0, hiddenPresent: 0, formDuplicate: 0 };
  for (const parsed of files)
    for (const claim of parsed.claims) {
      if (claim.unsupported !== undefined) {
        total.unreadable++;
        continue;
      }
      total.claims++;
      const own = hasRevision(claim.yearMonth);
      const rev = own ? resolveRevision(claim.yearMonth) : SELECTABLE_REVISIONS.find((r) => r.effectiveFrom <= claim.yearMonth && claim.yearMonth <= r.effectiveUntil);
      if (!own) total.noRevision++;
      const mapped = rev && own ? mapClaim(claim, rev) : null;
      const kubun = mapped ? mapped.lines.filter((l) => l.count > 0).map((l) => l.kubun) : [];
      const about: GenericAboutMore = { yearMonth: claim.yearMonth, generation: rev?.generation ?? "", outpatient: true, ...(rev ? { kisai: kisaiOf(rev, kubun) } : {}) };
      const table = pickSnapshot(db, "comment_kanren", about.yearMonth, about.generation) !== null;
      if (!table) total.noTable++;
      // 全部の指摘（上限で切らない）
      const found = ready ? g07.run(claim, db, about) : g07FormOnly(claim, db, about);
      const all: GenericFinding[] = Array.isArray(found) ? found : [];
      let shown = all;
      if (mapped && rev) {
        const ctx: ClaimContext = { claimId: "count", yearMonth: claim.yearMonth, facility, payer: parsed.payer, prefecture: parsed.prefecture, facts: unknown, events: [], recordsKnown: false, lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })), comments: withCommentLines(mapped.comments, claim), commentsKnown: true, partial: mapped.others.length > 0 };
        shown = overlap(evaluate(ctx), rev, false, mappedLinesOf(mapped.lines, mapped.origins), all).findings;
        total.formDuplicate += all.filter((f) => f.messageKey.startsWith("G07.form")).length - shown.filter((f) => f.messageKey.startsWith("G07.form")).length;
      }
      for (const f of shown) {
        if (f.messageKey === "G07.form" && f.certainty === "確定") total.form++;
        if (f.messageKey === "G07.form_day00") total.formDay00++;
        if (f.messageKey === "G07.form_future") total.formFuture++;
        if (f.messageKey === "G07.missing_any" && f.params.joken === "03") total.missing03++;
      }
      const c = ready && table ? conditionalOf(claim, db, about) : null;
      if (c) {
        total.conditional += c.items.length;
        total.hiddenR17 += c.hidden.r17;
        total.hiddenPresent += c.hidden.present;
      }
    }
  return total;
}
