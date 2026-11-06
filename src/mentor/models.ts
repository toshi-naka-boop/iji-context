// 役割ごとのモデル（config/models.json）。effort は考える深さ。
// メンターは本人のレベルで段を変えられる（byLevel。Lv.6 以上は聞かれる回数が減り、問いが難しくなる想定で深く考える）
import { readFileSync } from "node:fs";
import path from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRole = "mentor" | "veteranMentor" | "scribe" | "notice";
export type ModelChoice = { model: string; effort?: Effort };
type Entry = ModelChoice & { byLevel?: (ModelChoice & { fromLevel: number })[] };

export function modelFor(role: ModelRole, opts: { level?: number; root?: string } = {}): ModelChoice {
  const all = JSON.parse(readFileSync(path.join(opts.root ?? process.cwd(), "config", "models.json"), "utf8")) as Record<string, Entry>;
  const c = all[role];
  if (!c?.model) throw new Error(`config/models.json に ${role} がない`);
  const step = opts.level === undefined ? undefined : [...(c.byLevel ?? [])].sort((a, b) => b.fromLevel - a.fromLevel).find((s) => opts.level! >= s.fromLevel);
  const pick = step ?? c;
  return { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) };
}

/** query() の options に混ぜる形 */
export function modelOptions(c: ModelChoice | undefined): { model?: string; effort?: Effort } {
  if (!c) return {};
  return { model: c.model, ...(c.effort ? { effort: c.effort } : {}) };
}
