// 訪問の時点（レセコンに入れる前）の点検（spec FR-68。2026-11-07 ユーザー判断）
// その日までの実施と記録だけで判定する。月末までに結論が変わり得るルールは指摘にせず、見込みとして出す
import { visitCount } from "../engine/predicates";
import { resolveRevision } from "../engine/revisions";
import type { ClaimContext, EngineResult } from "../engine/types";

/**
 * 月の途中では指摘にしないルール。
 * R01：管理料の区分は月の訪問回数で決まる（月の途中の回数では誤りと言えない）。
 * R03：包括的支援加算の要否は、月の訪問回数で決まる管理料の区分に依る（design.md §2-3-3）。
 * R09：ターミナルケア加算は死亡日前 14 日以内の訪問回数で決まる（亡くなるまで分からない）
 */
export const DEFERRED_RULES = ["R01", "R03", "R09"];

/** 訪問診療と往診の日（その月の分） */
export function visitDays(ctx: ClaimContext): { date: string; type: "visit" | "oushin" }[] {
  const days = ctx.events
    .filter((e): e is typeof e & { date: string } => (e.type === "visit" || e.type === "oushin") && typeof e.date === "string" && e.date.startsWith(ctx.yearMonth))
    .map((e) => ({ date: e.date, type: e.type as "visit" | "oushin" }));
  return [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** その日までの実施と出来事だけにした請求（月はまだ終わっていない） */
export function contextAsOf(ctx: ClaimContext, date: string): ClaimContext {
  if (!date.startsWith(ctx.yearMonth)) throw new Error(`診療月の外の日: ${date}`);
  // 日付のない行はそのまま。日付のある行は、その日までの日だけ残す（全部残れば回数も元のまま）
  const lines = ctx.lines.flatMap((l) => {
    if (l.dates.length === 0) return [l];
    const dates = l.dates.filter((d) => d <= date);
    if (dates.length === 0) return [];
    return [dates.length === l.dates.length ? l : { ...l, dates, count: dates.length }];
  });
  const events = ctx.events.filter((e) => !("date" in e) || typeof e.date !== "string" || e.date <= date);
  return { ...ctx, lines, events, facts: { ...ctx.facts, visitsComplete: { known: true, value: false } } };
}

/** 月の途中の判定：月末まで決まらないルールの指摘を外す */
export function deferAtMidMonth<T extends Pick<EngineResult, "findings">>(r: T): T {
  return { ...r, findings: r.findings.filter((f) => !DEFERRED_RULES.includes(f.ruleId)) };
}

/** 見込み（指摘ではない）。管理料の区分は月末の訪問回数で決まる */
export function outlook(ctx: ClaimContext, date: string): string {
  const n = visitCount(contextAsOf(ctx, date), resolveRevision(ctx.yearMonth).consts);
  return `今月の訪問診療はここまで ${n} 回。管理料の区分は月末の回数で決まるので、まだ決めない`;
}
