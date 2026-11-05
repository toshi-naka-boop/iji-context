// トリガー判定（design.md §4-3）。発火すべきイベントを返すだけで、書き込みはしない
import { isAfter, latestReappointment, latestRevision, type Calendar } from "./calendar";
import { IDLE_DAYS, LAYER_TRIGGERS } from "./layers";
import { assertTime, ms } from "./time";
import type { KnowledgeMeta, LifecycleEvent, TriggerKind } from "./types";

export type FiredEvent = { knowledgeId: string; event: LifecycleEvent };

const DAY_MS = 86_400_000;

function idleReached(meta: KnowledgeMeta, now: string): boolean {
  const base = [meta.last_hit_at, meta.status_since]
    .filter((s): s is string => s !== null)
    .map((s) => ms(s))
    .reduce((a, b) => Math.max(a, b));
  return ms(now) - base >= IDLE_DAYS * DAY_MS;
}

/** 効くトリガー：自分の層に加え、relates_to をたどった元の知識の層の改定・改選（v21。round-15 X-57） */
function triggersOf(meta: KnowledgeMeta, byId: Map<string, KnowledgeMeta>): Record<TriggerKind, boolean> {
  const t = { ...LAYER_TRIGGERS[meta.layer] };
  const seen = new Set([meta.id]);
  let cur = meta.relates_to;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const origin = byId.get(cur);
    if (!origin) break;
    t.revision ||= LAYER_TRIGGERS[origin.layer].revision;
    t.reappointment ||= LAYER_TRIGGERS[origin.layer].reappointment;
    cur = origin.relates_to;
  }
  return t;
}

/** 1 つの知識について、発火するイベントを最大 1 件返す。優先順位は ①改定 → ②改選 → ③idle */
function evaluateOne(meta: KnowledgeMeta, now: string, cal: Calendar, t: Record<TriggerKind, boolean>): LifecycleEvent | null {
  if (meta.status === "承認済み") {
    if (t.revision) {
      const d = latestRevision(cal, now);
      if (d && isAfter(d, meta.status_since)) return { type: "TRIGGER", trigger: "revision" };
    }
    if (t.reappointment) {
      const d = latestReappointment(cal, meta.match.payer, meta.match.prefecture, now);
      if (d && isAfter(d, meta.status_since)) return { type: "TRIGGER", trigger: "reappointment" };
    }
    if (t.idle && idleReached(meta, now)) return { type: "TRIGGER", trigger: "idle" };
    return null;
  }
  if (meta.status === "要再検証") {
    if (t.idle && idleReached(meta, now)) return { type: "IDLE_EXPIRED" };
  }
  return null;
}

export function evaluateTriggers(metas: KnowledgeMeta[], now: string, calendar: Calendar): FiredEvent[] {
  assertTime(now, "now");
  const out: FiredEvent[] = [];
  const byId = new Map(metas.map((m) => [m.id, m]));
  for (const meta of metas) {
    const event = evaluateOne(meta, now, calendar, triggersOf(meta, byId));
    if (event) out.push({ knowledgeId: meta.id, event });
  }
  return out;
}
