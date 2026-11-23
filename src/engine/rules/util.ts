// ルールが共通で使う小道具
import type { ClaimContext, ClaimEvent, ClaimLine, FactKey, Finding, FindingKind, Rule } from "../types";

export function lineOf(ctx: ClaimContext, kubun: string): ClaimLine | undefined {
  return ctx.lines.find((l) => l.kubun === kubun && l.count > 0);
}

export function has(ctx: ClaimContext, kubun: string): boolean {
  return lineOf(ctx, kubun) !== undefined;
}

export function present(ctx: ClaimContext, kubuns: string[]): string[] {
  return kubuns.filter((k) => has(ctx, k));
}

export function eventsOf<T extends ClaimEvent["type"]>(ctx: ClaimContext, type: T): Extract<ClaimEvent, { type: T }>[] {
  return ctx.events.filter((e): e is Extract<ClaimEvent, { type: T }> => e.type === type);
}

/** known=true が前提の取り出し（needs で確かめた後に使う） */
export function fact<K extends FactKey>(ctx: ClaimContext, key: K) {
  const f = ctx.facts[key];
  if (!f?.known) throw new Error(`事実 ${key} が不明のまま check が呼ばれた`);
  return f.value as Extract<ClaimContext["facts"][K], { known: true }>["value"];
}

export function finding(rule: Pick<Rule, "id" | "reference">, kind: FindingKind, lineRefs: string[], key: string): Finding {
  return { ruleId: rule.id, kind, lineRefs, messageKey: `${rule.id}.${key}`, reference: rule.reference };
}

/** "YYYY-MM-DD" に日数を足す（UTC で計算し、時差の影響を受けない） */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
