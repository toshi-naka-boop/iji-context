// 知識の適用条件の判定（design.md §3）。宣言的な条件だけを見る決定的関数
import type { ClaimContext } from "../engine/types";
import type { KnowledgeMeta } from "./types";

/**
 * 知識が請求に適用されるか。
 * 条件を 1 つも持たない match は「判定できない」ので false。
 * facts の条件は、対応する事実が known=false なら適用せず。
 */
export type MatchState = "match" | "nomatch" | "unknown";

/**
 * 知識が請求に適用されるかを三値で返す。
 * 条件を 1 つも持たない match（空の kubunAll を含む）は「判定できない」ので nomatch。
 * facts の条件で事実が known=false のときは unknown（適用はしないが「直した」とも数えない。round-3 X-14）
 */
export function matchState(meta: KnowledgeMeta, ctx: ClaimContext, applied: string[]): MatchState {
  const m = meta.match;
  const kubunAll = m.kubunAll && m.kubunAll.length > 0 ? m.kubunAll : undefined;
  const hasCondition =
    m.ruleId !== undefined ||
    kubunAll !== undefined ||
    m.payer !== undefined ||
    m.prefecture !== undefined ||
    m.facts !== undefined ||
    (m.commentOn !== undefined && m.commentOn.length > 0) ||
    m.consecutiveMonths !== undefined;
  if (!hasCondition) return "nomatch";

  if (m.ruleId !== undefined && !applied.includes(m.ruleId)) return "nomatch";
  if (kubunAll !== undefined) {
    const have = new Set(ctx.lines.map((l) => l.kubun));
    if (!kubunAll.every((k) => have.has(k))) return "nomatch";
  }
  if (m.payer !== undefined && ctx.payer !== m.payer) return "nomatch";
  if (m.prefecture !== undefined && ctx.prefecture !== m.prefecture) return "nomatch";
  for (const c of m.commentOn ?? []) {
    const has = (ctx.comments ?? []).some((x) => x.kubun === c.kubun);
    if (has !== c.present) return "nomatch";
  }
  if (m.consecutiveMonths !== undefined && consecutiveMonths(ctx, m.consecutiveMonths.kubun) < m.consecutiveMonths.min) {
    return "nomatch";
  }

  const f = m.facts;
  let unknown = false;
  if (f) {
    const facts = ctx.facts;
    const checks: [boolean, () => boolean][] = [];
    if (f.careLevelMin !== undefined) checks.push([facts.careLevel.known, () => facts.careLevel.known && facts.careLevel.value >= f.careLevelMin!]);
    if (f.insurance !== undefined) checks.push([facts.insurance.known, () => facts.insurance.known && facts.insurance.value === f.insurance]);
    if (f.table8_2 !== undefined) checks.push([facts.table8_2.known, () => facts.table8_2.known && facts.table8_2.value === f.table8_2]);
    if (f.table7 !== undefined) checks.push([facts.table7.known, () => facts.table7.known && facts.table7.value === f.table7]);
    for (const [known, ok] of checks) {
      if (!known) unknown = true;
      else if (!ok()) return "nomatch";
    }
  }
  return unknown ? "unknown" : "match";
}

/** "YYYY-MM" の前月 */
function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** 当月を含め、その区分を何か月続けて算定しているか。history に載っていない月で途切れる（v6） */
export function consecutiveMonths(ctx: ClaimContext, kubun: string): number {
  if (!ctx.lines.some((l) => l.kubun === kubun)) return 0;
  const byMonth = new Map((ctx.history ?? []).map((h) => [h.yearMonth, h.kubun]));
  let n = 1;
  for (let ym = prevMonth(ctx.yearMonth); byMonth.get(ym)?.includes(kubun); ym = prevMonth(ym)) n += 1;
  return n;
}

/** 適用されるか（facts が不明なら適用せず） */
export function matches(meta: KnowledgeMeta, ctx: ClaimContext, applied: string[]): boolean {
  return matchState(meta, ctx, applied) === "match";
}
