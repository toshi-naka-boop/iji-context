// 役割ごとのモデル（config/models.json）。effort は考える深さ。
// メンターは本人のレベルで段を変えられる（byLevel。Lv.6 以上は聞かれる回数が減り、問いが難しくなる想定で深く考える）。
// 場面でも考える深さを変えられる（byScene。確定したあとの解説は少し深く考える）
import { readFileSync } from "node:fs";
import path from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRole = "mentor" | "veteranMentor" | "scribe" | "notice" | "chartExtract" | "chartSoap";
export type ModelChoice = { model: string; effort?: Effort };
/** メンターの場面：hint＝開いたときの声かけとヒント、explain＝確定したあとの解説 */
export type Scene = "hint" | "explain";
type Entry = ModelChoice & { byScene?: Partial<Record<Scene, Partial<ModelChoice>>>; byLevel?: (ModelChoice & { fromLevel: number })[] };

/** レベルの段（byLevel）があればそれを使い、なければ場面の上書き（byScene）を重ねる */
export function modelFor(role: ModelRole, opts: { level?: number; scene?: Scene; root?: string } = {}): ModelChoice {
  const all = JSON.parse(readFileSync(path.join(opts.root ?? process.cwd(), "config", "models.json"), "utf8")) as Record<string, Entry>;
  const c = all[role];
  if (!c?.model) throw new Error(`config/models.json に ${role} がない`);
  const step = opts.level === undefined ? undefined : [...(c.byLevel ?? [])].sort((a, b) => b.fromLevel - a.fromLevel).find((s) => opts.level! >= s.fromLevel);
  const pick: ModelChoice = step ?? { model: c.model, effort: c.effort, ...(opts.scene ? c.byScene?.[opts.scene] : {}) };
  return { model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) };
}

/** query() の options に混ぜる形 */
export function modelOptions(c: ModelChoice | undefined): { model?: string; effort?: Effort } {
  if (!c) return {};
  return { model: c.model, ...(c.effort ? { effort: c.effort } : {}) };
}
