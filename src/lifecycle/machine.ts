// 状態遷移（design.md §4-2）。表駆動の純関数 1 つに閉じる。時刻は引数 now
import { assertTime, ms } from "./time";
import { LAYER_TRIGGERS } from "./layers";
import type {
  Actor,
  Basis,
  Effect,
  KnowledgeMeta,
  KnowledgeStatus,
  LifecycleEvent,
  TransitionResult,
} from "./types";

type Rule = {
  /** 遷移後の状態 */
  to: KnowledgeStatus;
  /** 遷移の前提チェック。満たさなければ例外メッセージを返す */
  guard?: (meta: KnowledgeMeta, event: LifecycleEvent) => string | null;
  /** 遷移に付随する更新（meta の浅いコピーに対して行う） */
  apply?: (meta: KnowledgeMeta, event: LifecycleEvent, now: string) => void;
  effects?: (meta: KnowledgeMeta, event: LifecycleEvent) => Effect[];
  actor: (event: LifecycleEvent) => Actor;
};

const sys = (): Actor => "system";
const veteran = (): Actor => "veteran";

const needReason = (_m: KnowledgeMeta, e: LifecycleEvent): string | null =>
  "reason" in e && typeof e.reason === "string" && e.reason.trim() !== ""
    ? null
    : "retired_reason（reason）が必須";

const assessedOnly = (m: KnowledgeMeta): string | null =>
  m.source_event.type === "査定" ? null : "REEXAM_FILED は査定由来の知識だけ";

const retire = (m: KnowledgeMeta, e: LifecycleEvent): void => {
  if ("reason" in e) m.retired_reason = e.reason;
};

/** USED は last_used_at を更新する。last_hit_at は max(last_used_at, …) なので合わせて進める（v7） */
const touchUsed = (m: KnowledgeMeta, _e: LifecycleEvent, now: string): void => {
  m.last_used_at = now;
  if (m.last_hit_at === null || ms(m.last_hit_at) < ms(now)) m.last_hit_at = now;
};

const disposal =
  (cause: "IDLE_EXPIRED" | "COUNTER_EXAMPLE" | "RECHECK_FAIL") =>
  (m: KnowledgeMeta): Effect[] => [{ type: "DISPOSAL_PROPOSAL", knowledgeId: m.id, cause }];

/** key は「現在の状態|イベント種別」。TRIGGER・REEXAM_RESULT・RECHECK_PASS は種別の中で分岐する */
function lookup(status: KnowledgeStatus, event: LifecycleEvent): Rule | undefined {
  switch (`${status}|${event.type}`) {
    case "未検証|VERIFY_APPROVE":
      return { to: "承認済み", actor: veteran };
    case "未検証|VERIFY_REJECT":
      return { to: "保管", guard: needReason, apply: retire, actor: veteran };
    case "未検証|EMPATHY":
      return {
        to: "未検証",
        apply: (m) => {
          m.empathy += 1;
        },
        actor: () => "clerk",
      };
    case "未検証|REEXAM_FILED":
    case "承認済み|REEXAM_FILED":
      return { to: "contested", guard: assessedOnly, actor: () => "clerk" };
    case "contested|REEXAM_RESULT":
      if (event.type !== "REEXAM_RESULT") return undefined;
      return event.result === "原審どおり"
        ? { to: "承認済み", actor: sys }
        : {
            to: "保管",
            effects: (m) => [{ type: "CREATE_REEXAM_ALLOWED", sourceId: m.id }],
            actor: sys,
          };
    case "承認済み|TRIGGER":
      return {
        to: "要再検証",
        // relates_to を持つ知識は元の知識の層の改定・改選も効く（v21。round-15 X-57）。元の層の判定は triggers.ts
        guard: (m, e) =>
          e.type === "TRIGGER" && (LAYER_TRIGGERS[m.layer][e.trigger] || (m.relates_to !== null && e.trigger !== "idle"))
            ? null
            : `${m.layer}層に効かないトリガー`,
        actor: sys,
      };
    // 1 回の外れで要再検証に下げる（C-31）。misses は store が数え直す（v8）
    case "承認済み|COUNTER_EXAMPLE":
      return { to: "要再検証", actor: sys };
    case "承認済み|USED":
    case "要再検証|USED":
      return { to: status, apply: touchUsed, actor: sys };
    case "要再検証|RECHECK_PASS":
      return {
        to: "承認済み",
        actor: (e) => (e.type === "RECHECK_PASS" && e.via === "veteran" ? "veteran" : "system"),
      };
    case "要再検証|RECHECK_FAIL":
      return { to: "停止", effects: disposal("RECHECK_FAIL"), actor: veteran };
    case "要再検証|COUNTER_EXAMPLE":
      return { to: "停止", effects: disposal("COUNTER_EXAMPLE"), actor: sys };
    case "要再検証|IDLE_EXPIRED":
      return {
        to: "停止",
        guard: (m) => (LAYER_TRIGGERS[m.layer].idle ? null : `${m.layer}層には③ idle が効かない`),
        effects: disposal("IDLE_EXPIRED"),
        actor: sys,
      };
    case "停止|DISPOSAL_APPROVE":
      return { to: "保管", guard: needReason, apply: retire, actor: veteran };
    case "停止|DISPOSAL_REJECT":
      return { to: "承認済み", actor: veteran };
    default:
      return undefined;
  }
}


/** history に残すイベント名（RECHECK_PASS{claim} のように枝分かれを含める） */
export function eventLabel(event: LifecycleEvent): string {
  switch (event.type) {
    case "TRIGGER":
      return `TRIGGER{${event.trigger}}`;
    case "RECHECK_PASS":
      return `RECHECK_PASS{${event.via}}`;
    case "REEXAM_RESULT":
      return `REEXAM_RESULT{${event.result}}`;
    default:
      return event.type;
  }
}

/** 状態遷移。表にない組み合わせは例外。入力の meta は書き換えない。basis は状態が変わるときの history に残す */
export function transition(
  meta: KnowledgeMeta,
  event: LifecycleEvent,
  now: string,
  basis: Basis | null = null,
): TransitionResult {
  assertTime(now, "now");
  const rule = lookup(meta.status, event);
  if (!rule) {
    throw new Error(`許されない遷移: 状態「${meta.status}」にイベント ${event.type} は適用できない（${meta.id}）`);
  }
  const problem = rule.guard?.(meta, event) ?? null;
  if (problem) throw new Error(`${meta.id}: ${meta.status} + ${event.type} は拒否: ${problem}`);

  const next: KnowledgeMeta = { ...meta, history: [...meta.history] };
  rule.apply?.(next, event, now);
  if (rule.to !== meta.status) {
    next.history.push({
      at: now,
      from: meta.status,
      to: rule.to,
      event: eventLabel(event),
      actor: rule.actor(event),
      basis,
    });
    next.status = rule.to;
    next.status_since = now;
  }
  return { meta: next, effects: rule.effects?.(next, event) ?? [] };
}
