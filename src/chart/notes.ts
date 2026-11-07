// 本人が書いた訪問カルテを、その月の請求と照合用のカルテに重ねる（spec FR-69）。決まった規則だけで行う
import { C001_VISIT } from "../engine/rules/util";
import type { ClaimContext } from "../engine/types";
import type { Chart } from "../uke/crosscheck";
import type { ChartNote, ExtractedFact } from "./extract";

export type VisitKind = "訪問診療" | "往診";
/** 本人が確かめた事実まで済んだカルテ */
export type ConfirmedNote = { date: string; kind: VisitKind; note: ChartNote; facts: ExtractedFact[] };

/**
 * 訪問の出来事と行を足す。訪問診療はその患者の訪問診療の区分（なければ同一建物居住者以外）、往診は往診料。
 * 同じ日の同じ種類の訪問がすでにあれば足さない。急性増悪の記載があれば、その月の急性増悪を「あり」にする
 */
export function withNotes(ctx: ClaimContext, notes: ConfirmedNote[]): ClaimContext {
  let lines = ctx.lines.map((l) => ({ ...l, dates: [...l.dates] }));
  const events = [...ctx.events];
  for (const n of notes) {
    const type = n.kind === "往診" ? "oushin" : "visit";
    if (events.some((e) => e.type === type && "date" in e && e.date === n.date)) continue;
    if (type === "visit") {
      const same = events.find((e) => e.type === "visit");
      events.push({ type: "visit", date: n.date, sameBuildingCount: same && "sameBuildingCount" in same ? same.sameBuildingCount : 1 });
    } else events.push({ type: "oushin", date: n.date, kind: "normal" });
    const kubun = type === "oushin" ? "C000" : (lines.find((l) => C001_VISIT.includes(l.kubun))?.kubun ?? "C001_1I");
    const line = lines.find((l) => l.kubun === kubun);
    if (line) {
      if (!line.dates.includes(n.date)) lines = lines.map((l) => (l === line ? { ...l, dates: [...l.dates, n.date].sort(), count: l.count + 1 } : l));
    } else lines = [...lines, { kubun, count: 1, dates: [n.date] }];
  }
  const acute = notes.some((n) => n.facts.some((f) => f.kind === "急性増悪"));
  return { ...ctx, lines, events, facts: acute ? { ...ctx.facts, acuteExacerbation: { known: true, value: true } } : ctx.facts };
}

/** 照合用のカルテに、書いた記録と処方（分類名）を足す */
export function chartWithNotes(chart: Chart | null, claimId: string, notes: ConfirmedNote[]): Chart | null {
  if (!chart && notes.length === 0) return null;
  const base: Chart = chart ?? { claimId, entries: [], prescriptions: [] };
  return {
    ...base,
    entries: [...base.entries, ...notes.map((n) => ({ date: n.date, s: n.note.s, a: n.note.a, p: n.note.p }))].sort((a, b) => (a.date < b.date ? -1 : 1)),
    prescriptions: [...base.prescriptions, ...notes.flatMap((n) => n.facts.filter((f) => f.kind === "処方").map((f) => ({ date: n.date, category: f.value })))],
  };
}
