// 本人が書いた訪問カルテを、その月の請求と照合用のカルテに重ねる（spec FR-69）。決まった規則だけで行う
import { resolveRevision } from "../engine/revisions";
import type { ClaimContext, ClaimEvent, Facts } from "../engine/types";
import type { Chart } from "../uke/crosscheck";
import type { StoredActs } from "./acts";
import type { ChartNote, ExtractedFact } from "./extract";

export type VisitKind = "訪問診療" | "往診";
/** 本人が確かめた事実まで済んだカルテ */
export type ConfirmedNote = { date: string; kind: VisitKind; note: ChartNote; facts: ExtractedFact[]; acts?: StoredActs | null };

/**
 * カルテ→出来事（1 か所。訪問の記録と算定行の導出で共有する。design.md §2-8）。
 * 訪問診療・往診の出来事を足す。同じ日の同じ種類の訪問がすでにあれば足さない。急性増悪の記載があれば、その月の急性増悪を「あり」にする。
 * 不安・不眠の薬（本人が確かめた「あり」「なし」）は、その日の既存の処方の出来事（psychotropic）に重ねる。処方の出来事は作らない（その日に処方の出来事がなければ何もしない）。
 * 「あり」は真にする。「なし」は、記録が分からない（null）ときだけ偽にする（記録やほかのカルテが「あり」の日を、偽で上書きしない。偽は医師への確認を省くので、安全側に倒す）
 */
export function eventsFromNotes(events: ClaimEvent[], facts: Facts, notes: ConfirmedNote[]): { events: ClaimEvent[]; facts: Facts } {
  const out = [...events];
  for (const n of notes) {
    const type = n.kind === "往診" ? "oushin" : "visit";
    if (out.some((e) => e.type === type && "date" in e && e.date === n.date)) continue;
    if (type === "visit") {
      const same = out.find((e) => e.type === "visit");
      out.push({ type: "visit", date: n.date, sameBuildingCount: same && "sameBuildingCount" in same ? same.sameBuildingCount : 1 });
    } else out.push({ type: "oushin", date: n.date, kind: "normal" });
  }
  const acute = notes.some((n) => n.facts.some((f) => f.kind === "急性増悪"));
  /** 日付 → その日のカルテのどれかが「あり」か */
  const psychotropic = new Map<string, boolean>();
  for (const n of notes) for (const f of n.facts) if (f.kind === "不安・不眠の薬") psychotropic.set(n.date, psychotropic.get(n.date) === true || f.value === "あり");
  const overlaid = out.map((e) => (e.type === "prescription" && psychotropic.has(e.date) ? { ...e, psychotropic: psychotropic.get(e.date) === true ? true : (e.psychotropic ?? false) } : e));
  return { events: overlaid, facts: acute ? { ...facts, acuteExacerbation: { known: true, value: true } } : facts };
}

/**
 * 訪問の出来事（eventsFromNotes）と行を足す。訪問診療はその患者の訪問診療の区分（なければ同一建物居住者以外）、往診は往診料
 */
export function withNotes(ctx: ClaimContext, notes: ConfirmedNote[]): ClaimContext {
  const { visitKubun, oushin } = resolveRevision(ctx.yearMonth).consts;
  const { events, facts } = eventsFromNotes(ctx.events, ctx.facts, notes);
  let lines = ctx.lines.map((l) => ({ ...l, dates: [...l.dates] }));
  // 足された出来事（末尾に並ぶ）ごとに、行を足す
  for (const e of events.slice(ctx.events.length)) {
    if (e.type !== "visit" && e.type !== "oushin") continue;
    const date = e.date;
    const kubun = e.type === "oushin" ? oushin.kubun : (lines.find((l) => visitKubun.includes(l.kubun))?.kubun ?? visitKubun[0]);
    const line = lines.find((l) => l.kubun === kubun);
    if (line) {
      if (!line.dates.includes(date)) lines = lines.map((l) => (l === line ? { ...l, dates: [...l.dates, date].sort(), count: l.count + 1 } : l));
    } else lines = [...lines, { kubun, count: 1, dates: [date] }];
  }
  return { ...ctx, lines, events, facts };
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
