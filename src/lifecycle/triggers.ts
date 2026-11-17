// トリガー判定（design.md §4-3）。発火すべきイベントを返すだけで、書き込みはしない
import { isAfter, latestReappointment, latestRevision, type Calendar } from "./calendar";
import { IDLE_DAYS, LAYER_TRIGGERS } from "./layers";
import { assertTime, ms } from "./time";
import type { KnowledgeMeta, LifecycleEvent, TriggerKind } from "./types";
import { conflictKeys } from "../official/match";
import type { OfficialInput } from "../official/types";

/** officialIds：④ のとき、未確認だった矛盾の恐れの文書の鍵（昇順。history の basis に残す） */
export type FiredEvent = { knowledgeId: string; event: LifecycleEvent; officialIds?: string[] };

const DAY_MS = 86_400_000;

function idleReached(meta: KnowledgeMeta, now: string): boolean {
  const base = [meta.last_hit_at, meta.status_since]
    .filter((s): s is string => s !== null)
    .map((s) => ms(s))
    .reduce((a, b) => Math.max(a, b));
  return ms(now) - base >= IDLE_DAYS * DAY_MS;
}

/** 効くトリガー：自分の層に加え、relates_to をたどった元の知識の層の改定・改選（v21。round-15 X-57）。④ 公的文書は自分の層だけ */
export function triggersOf(meta: KnowledgeMeta, byId: Map<string, KnowledgeMeta>): Record<TriggerKind, boolean> {
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

/** 1 つの知識について、発火するイベントを最大 1 件返す。優先順位は ①改定 → ②改選 → ④公的文書 → ③idle */
function evaluateOne(
  meta: KnowledgeMeta,
  now: string,
  cal: Calendar,
  t: Record<TriggerKind, boolean>,
  official: OfficialInput | undefined,
): Omit<FiredEvent, "knowledgeId"> | null {
  const fire = (event: LifecycleEvent) => ({ event });
  if (meta.status === "承認済み") {
    if (t.revision) {
      const d = latestRevision(cal, now);
      if (d && isAfter(d, meta.status_since)) return fire({ type: "TRIGGER", trigger: "revision" });
    }
    if (t.reappointment) {
      const d = latestReappointment(cal, meta.match.payer, meta.match.prefecture, now);
      if (d && isAfter(d, meta.status_since)) return fire({ type: "TRIGGER", trigger: "reappointment" });
    }
    // ④：いま矛盾する文書の鍵のうち、会議で確認済み（official_seen）にないものがある。文書がいつ入ったかは見ない
    if (official && t.official) {
      const unseen = conflictKeys(meta, official, now).filter((k) => !meta.official_seen.includes(k));
      if (unseen.length > 0) return { event: { type: "TRIGGER", trigger: "official" }, officialIds: unseen };
    }
    if (t.idle && idleReached(meta, now)) return fire({ type: "TRIGGER", trigger: "idle" });
    return null;
  }
  if (meta.status === "要再検証") {
    if (t.idle && idleReached(meta, now)) return fire({ type: "IDLE_EXPIRED" });
  }
  return null;
}

/** official を省くと ④ は判定しない */
export function evaluateTriggers(metas: KnowledgeMeta[], now: string, calendar: Calendar, official?: OfficialInput): FiredEvent[] {
  assertTime(now, "now");
  const out: FiredEvent[] = [];
  const byId = new Map(metas.map((m) => [m.id, m]));
  for (const meta of metas) {
    const fired = evaluateOne(meta, now, calendar, triggersOf(meta, byId), official);
    if (fired) out.push({ knowledgeId: meta.id, ...fired });
  }
  return out;
}
