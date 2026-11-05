// レセメン会議の整理・議題・回答の反映（design.md §4-4、v20）
// 状態を動かす判定は決まった規則だけで計算する。LLM（メンター）は議題を言い換えて届けるだけ
// v20：結果では知識を更新しない（使い続ける）。毎週土日の会議で、外れと同じ知識を適用したほかの請求を確認し、責任者が判断する
import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { applications, digestItems, reviews, submissions } from "../db/schema";
import { confirmSubmission, effectiveResult, type Db, type Evaluation, type Outcome } from "./applications";
import { latestReappointment, latestRevision, type Calendar } from "./calendar";
import {
  appendBody,
  applyEvent,
  createKnowledge,
  listKnowledge,
  readBody,
  readKnowledge,
  fitSummary,
  writeCounts,
  type StoreOptions,
} from "./store";
import { assertTime, canonicalTime, ms } from "./time";
import { evaluateTriggers } from "./triggers";
import type { Basis, KnowledgeMeta, LifecycleEvent, TriggerKind } from "./types";

export type ReviewDeps = {
  db: Db;
  store: StoreOptions;
  calendar: Calendar;
  /** 制度層の知識が「関係あり」かを決める、エンジンの各ルールの kubun */
  ruleKubun: (ruleId: string) => string[];
};

// ---------------------------------------------------------------------------
// 提出（確定）

/** 提出を確定して適用記録を書き、avoided の知識に USED を出す（結果を待たない。C-6） */
export function submit(
  deps: ReviewDeps,
  input: { submissionId: string; final: Evaluation; earlier: Evaluation[]; now: string },
): void {
  const { avoided } = confirmSubmission(deps.db, { ...input, knowledge: listKnowledge(deps.store) });
  for (const id of avoided) applyEvent(deps.store, id, { type: "USED" }, input.now);
}

// ---------------------------------------------------------------------------
// 効果（変換表）

type EffectKind = "hit" | "miss" | "none";

/** 提出×知識の観測（今有効な結果があり、superseded でない提出だけ） */
type Observation = {
  submissionId: string;
  rev: string;
  effect: EffectKind;
  /** 結果の kubun のうち、知識に関係ある区分 */
  relatedKubun: string[];
  importedAt: string;
  /** 今有効な結果の id（「会議で扱った」の単位。v20） */
  resultId: string;
};

/** 提出結果から自動で効果を出す知識か（§3：matchApprox でなく、kubunAll か ruleId を持つ） */
function judgeable(m: KnowledgeMeta): boolean {
  return !m.matchApprox && (m.match.ruleId !== undefined || (m.match.kubunAll?.length ?? 0) > 0);
}

/** 「関係あり」の区分：ruleId を持つ知識は層にかかわらずルールの kubun、それ以外は kubunAll（round-3 C-17、v20。round-14 X-55） */
function relevantKubun(m: KnowledgeMeta, deps: ReviewDeps): string[] {
  return m.match.ruleId !== undefined ? deps.ruleKubun(m.match.ruleId) : (m.match.kubunAll ?? []);
}

/** §4-4 の変換表 */
export function effectOf(
  role: "final" | "avoided" | "ignored",
  polarity: "allow" | "avoid",
  outcome: Outcome,
  related: boolean,
): EffectKind {
  if (role !== "final") return "none";
  if (outcome === "返戻" && !related) return "none"; // round-4 C-21
  const failed = outcome !== "通過" && related; // 関係のない査定は通過と同じ（C-15）
  if (polarity === "allow") return failed ? "miss" : "hit";
  return failed ? "hit" : "miss";
}

function observations(deps: ReviewDeps, meta: KnowledgeMeta): Observation[] {
  if (!judgeable(meta)) return [];
  const rel = relevantKubun(meta, deps);
  const rows = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.knowledgeId, meta.id), eq(submissions.superseded, false)))
    .all();
  const out: Observation[] = [];
  for (const r of rows) {
    const res = effectiveResult(deps.db, r.submissions.submissionId);
    if (!res) continue;
    const relatedKubun = res.kubun.filter((k) => rel.includes(k));
    out.push({
      submissionId: r.submissions.submissionId,
      rev: r.applications.rev,
      effect: effectOf(r.applications.role, meta.polarity, res.outcome, relatedKubun.length > 0),
      relatedKubun,
      importedAt: res.importedAt,
      resultId: res.resultId,
    });
  }
  return out.sort((a, b) => (a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 数え直し（round-5 C-23。足し引きしない）

export function recount(deps: ReviewDeps, id: string): KnowledgeMeta {
  const meta = readKnowledge(deps.store, id);
  if (!meta) throw new Error(`知識が見つからない: ${id}`);
  const obs = observations(deps, meta).filter((o) => o.rev === meta.rev);
  const hitObs = obs.filter((o) => o.effect === "hit");
  const ignoredMisses = new Set(
    deps.db
      .select()
      .from(digestItems)
      .where(and(eq(digestItems.kind, "ignored"), eq(digestItems.knowledgeId, id), eq(digestItems.answer, 2), eq(digestItems.applied, true)))
      .all()
      .map((r) => r.submissionId),
  ).size;
  const candidates = [meta.last_used_at, ...hitObs.map((o) => o.importedAt)].filter((s): s is string => s !== null);
  const last = candidates.length ? candidates.reduce((a, b) => (ms(a) >= ms(b) ? a : b)) : null;
  return writeCounts(deps.store, id, {
    hits: hitObs.length,
    misses: obs.filter((o) => o.effect === "miss").length + ignoredMisses,
    last_hit_at: last,
  });
}

// ---------------------------------------------------------------------------
// 会議の日（v20。毎週。曜日は責任者が config/review.json の meetingWeekday で設定）

/** 前回の整理（lastRanAt）の後に、その曜日（0＝日〜6＝土）の日本時間 0 時を過ぎたか。前回がなければ true */
export function dueMeeting(lastRanAt: string | null, now: string, weekday: number): boolean {
  assertTime(now, "now");
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error(`会議の曜日は 0〜6 の整数: ${weekday}`);
  if (lastRanAt === null) return true;
  const DAY = 86_400_000;
  const JST = 9 * 3_600_000;
  const to = ms(now);
  // now 以前で直近の、その曜日の日本時間 0 時
  const jstNow = to + JST;
  const dayStart = Math.floor(jstNow / DAY) * DAY; // 日本時間の今日 0 時（JST 基準の数値）
  const dow = new Date(dayStart).getUTCDay();
  const latest = dayStart - ((dow - weekday + 7) % 7) * DAY - JST;
  return ms(lastRanAt) < latest && latest <= to;
}

// ---------------------------------------------------------------------------
// 会議の整理

export type ReviewHooks = {
  /** テスト用：各手順の途中で例外を投げて「止まった」状態を作る */
  onStep?: (step: "recover" | "recount" | "trigger" | "digest", knowledgeId?: string) => void;
};

/** 会議の整理を回す。何度回しても同じ結果になる（途中で止まっても、もう一度回せばよい） */
export function meetingReview(deps: ReviewDeps, now: string, hooks: ReviewHooks = {}): { reviewId: string } {
  assertTime(now, "now");
  // 同じ瞬間なら表記（+09:00／Z）が違っても同じ整理（v16 §3）
  const ranAt = canonicalTime(now);
  const reviewId = `review-${ranAt}`;

  // 手順 0：答えの拾い直し（round-10 C-47）
  const pending = deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.applied, false), eq(digestItems.stale, false)))
    .all()
    .filter((r) => r.answer !== null)
    .sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  for (const r of pending) {
    hooks.onStep?.("recover", r.knowledgeId);
    reflect(deps, r.itemId, now);
  }

  // 手順 1：数え直し（トリガーより先。round-10 C-46）
  for (const meta of listKnowledge(deps.store)) {
    hooks.onStep?.("recount", meta.id);
    recount(deps, meta.id);
  }

  // 手順 2：トリガー
  for (const fired of evaluateTriggers(listKnowledge(deps.store), now, deps.calendar)) {
    hooks.onStep?.("trigger", fired.knowledgeId);
    applyEvent(deps.store, fired.knowledgeId, fired.event, now, { trigger: triggerOf(fired.event) });
  }

  // 手順 3：議題
  hooks.onStep?.("digest");
  buildItems(deps, reviewId, now);
  // 整理を記録するのは最後（途中で止まった整理が、議題と次の会議の日の判定を隠さないように。round-14 X-56）
  deps.db.insert(reviews).values({ reviewId, ranAt }).onConflictDoNothing().run();
  return { reviewId };
}

function triggerOf(e: LifecycleEvent): TriggerKind {
  if (e.type === "TRIGGER") return e.trigger;
  if (e.type === "IDLE_EXPIRED") return "idle";
  throw new Error(`トリガーでないイベント: ${e.type}`);
}

// ---------------------------------------------------------------------------
// まとめの項目

type ItemKind = "miss" | "recheck" | "ignored" | "disposal";

function basisDate(deps: ReviewDeps, meta: KnowledgeMeta, now: string): string | null {
  if (meta.layer === "制度") return latestRevision(deps.calendar, now);
  if (meta.layer === "地域") return latestReappointment(deps.calendar, meta.match.payer, meta.match.prefecture, now);
  return null;
}

/** 整理時点の snapshot。miss・recheck・disposal は状態・版・基準日、ignored は版だけ（round-11 C-51）。miss の外れは入れない */
function snapshotOf(deps: ReviewDeps, meta: KnowledgeMeta, now: string, kind: ItemKind): string {
  if (kind === "ignored") return JSON.stringify({ rev: meta.rev });
  return JSON.stringify({ status: meta.status, status_since: meta.status_since, rev: meta.rev, basisDate: basisDate(deps, meta, now) });
}

/** 議題に載せる外れ（v20） */
export type MissEntry = { submissionId: string; resultId: string; kubun: string[] };

/** 同じ知識を同じ rev で適用したほかの提出（v20。並べるだけで、請求には触れない） */
export type SameApplied = { submissionId: string; claimId: string; yearMonth: string; result: Outcome | "結果待ち" };

export type ItemReason =
  | { kind: "miss"; misses: MissEntry[]; sameApplied: SameApplied[] }
  | { kind: "recheck"; event: string; submissionIds?: string[]; kubun?: string[]; trigger?: TriggerKind }
  | { kind: "ignored"; removedKubun: string[] }
  | { kind: "disposal"; event: string; candidateId?: string | null };

function lastEntryInto(meta: KnowledgeMeta, status: string) {
  return [...meta.history].reverse().find((h) => h.to === status);
}

function recheckReason(deps: ReviewDeps, meta: KnowledgeMeta): ItemReason {
  const e = lastEntryInto(meta, "要再検証");
  const b = e?.basis ?? {};
  return { kind: "recheck", event: e?.event ?? "", submissionIds: b.submissionIds, kubun: b.kubun, trigger: b.trigger };
}

const missKey = (submissionId: string, resultId: string) => `${submissionId}\0${resultId}`;

/** 会議で扱った外れ：miss 項目に回答 1 か 2 が反映されたもの（v20） */
function discussed(deps: ReviewDeps, knowledgeId: string): Set<string> {
  const rows = deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.kind, "miss"), eq(digestItems.knowledgeId, knowledgeId), eq(digestItems.applied, true)))
    .all()
    .filter((r) => r.answer === 1 || r.answer === 2);
  const out = new Set<string>();
  for (const r of rows) {
    const reason = JSON.parse(r.reason) as ItemReason;
    if (reason.kind === "miss") for (const m of reason.misses) out.add(missKey(m.submissionId, m.resultId));
  }
  return out;
}

/** 外れの確認の理由。扱っていない外れがなければ null */
function missReason(deps: ReviewDeps, meta: KnowledgeMeta): ItemReason | null {
  const done = discussed(deps, meta.id);
  const misses = observations(deps, meta)
    .filter((o) => o.rev === meta.rev && o.effect === "miss" && !done.has(missKey(o.submissionId, o.resultId)))
    .map((o) => ({ submissionId: o.submissionId, resultId: o.resultId, kubun: o.relatedKubun }));
  if (misses.length === 0) return null;
  const missIds = new Set(misses.map((m) => m.submissionId));
  const sameApplied = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.knowledgeId, meta.id), eq(applications.rev, meta.rev), eq(applications.role, "final"), eq(submissions.superseded, false)))
    .all()
    .filter((r) => !missIds.has(r.submissions.submissionId))
    .map((r) => ({
      submissionId: r.submissions.submissionId,
      claimId: r.submissions.claimId,
      yearMonth: r.submissions.yearMonth,
      result: effectiveResult(deps.db, r.submissions.submissionId)?.outcome ?? ("結果待ち" as const),
    }))
    .sort((x, y) => (x.submissionId < y.submissionId ? -1 : 1));
  return { kind: "miss", misses, sameApplied };
}

function disposalReason(deps: ReviewDeps, meta: KnowledgeMeta): ItemReason {
  const e = lastEntryInto(meta, "停止");
  const b = e?.basis ?? {};
  if (e?.event === "RECHECK_FAIL") {
    return { kind: "disposal", event: e.event, candidateId: b.itemId ? findCandidate(deps, meta.id, b.itemId) : null };
  }
  return { kind: "disposal", event: e?.event ?? "" };
}

/** 項目を作る。（種類・知識・提出・snapshot）が同じ未回答の項目は使い回す（round-10 C-49） */
function upsertItem(
  deps: ReviewDeps,
  reviewId: string,
  item: { kind: ItemKind; knowledgeId: string; submissionId: string | null; snapshot: string; reason: ItemReason },
): void {
  const reason = JSON.stringify(item.reason);
  const reuse = deps.db
    .select()
    .from(digestItems)
    .where(
      and(
        eq(digestItems.kind, item.kind),
        eq(digestItems.knowledgeId, item.knowledgeId),
        item.submissionId === null ? isNull(digestItems.submissionId) : eq(digestItems.submissionId, item.submissionId),
        eq(digestItems.snapshot, item.snapshot),
        isNull(digestItems.answer),
      ),
    )
    .get();
  if (reuse) {
    deps.db.update(digestItems).set({ reviewId, reason }).where(eq(digestItems.itemId, reuse.itemId)).run();
    return;
  }
  const itemId = createHash("sha256")
    .update([item.kind, item.knowledgeId, item.submissionId ?? "", item.snapshot, reviewId].join("\0"))
    .digest("hex")
    .slice(0, 16);
  deps.db
    .insert(digestItems)
    .values({ itemId, reviewId, kind: item.kind, knowledgeId: item.knowledgeId, submissionId: item.submissionId, snapshot: item.snapshot, reason })
    .onConflictDoNothing()
    .run();
}

function isClosed(deps: ReviewDeps, submissionId: string, knowledgeId: string): boolean {
  return (
    deps.db
      .select()
      .from(digestItems)
      .where(
        and(
          eq(digestItems.kind, "ignored"),
          eq(digestItems.submissionId, submissionId),
          eq(digestItems.knowledgeId, knowledgeId),
          eq(digestItems.applied, true),
        ),
      )
      .get() !== undefined
  );
}

/** 外れの確認の答えを待っている recheck の答え（回答あり・未反映・stale でない）（v21。round-15 C-60） */
function heldRecheck(deps: ReviewDeps, knowledgeId: string) {
  return deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.kind, "recheck"), eq(digestItems.knowledgeId, knowledgeId), eq(digestItems.applied, false), eq(digestItems.stale, false)))
    .all()
    .filter((r) => r.answer !== null);
}

function buildItems(deps: ReviewDeps, reviewId: string, now: string): void {
  const metas = listKnowledge(deps.store);
  for (const meta of metas) {
    if ((meta.status === "承認済み" || meta.status === "要再検証") && judgeable(meta)) {
      const reason = missReason(deps, meta);
      if (reason) upsertItem(deps, reviewId, { kind: "miss", reason, knowledgeId: meta.id, submissionId: null, snapshot: snapshotOf(deps, meta, now, "miss") });
    }
    let item: { kind: ItemKind; reason: ItemReason } | null = null;
    // 外れの確認の答えを待っている recheck の答えがあれば、新しく載せない（v21）
    if (meta.status === "要再検証" && heldRecheck(deps, meta.id).length === 0) item = { kind: "recheck", reason: recheckReason(deps, meta) };
    else if (meta.status === "停止") item = { kind: "disposal", reason: disposalReason(deps, meta) };
    if (item) upsertItem(deps, reviewId, { ...item, knowledgeId: meta.id, submissionId: null, snapshot: snapshotOf(deps, meta, now, item.kind) });
  }
  const ignored = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.role, "ignored"), eq(submissions.superseded, false)))
    .all();
  for (const r of ignored) {
    const { submissionId, knowledgeId } = r.applications;
    const meta = metas.find((m) => m.id === knowledgeId);
    // 保管の知識には聞かない（v16 ユーザー判断）
    if (!meta || meta.status === "保管" || isClosed(deps, submissionId, knowledgeId)) continue;
    const reason: ItemReason = { kind: "ignored", removedKubun: JSON.parse(r.applications.removedKubun) as string[] };
    upsertItem(deps, reviewId, { kind: "ignored", knowledgeId, submissionId, snapshot: snapshotOf(deps, meta, now, "ignored"), reason });
  }
}

// ---------------------------------------------------------------------------
// まとめ（決定的。点数・金額の欄を持たない）

export type Choice = { no: 1 | 2 | 3 | 4; label: string; freeText: boolean };

export const CHOICES: Record<ItemKind, Choice[]> = {
  miss: [
    { no: 1, label: "今も正しい（外れは前提条件の違いなど）", freeText: false },
    { no: 2, label: "直す必要がある（足りない条件・変わった内容）", freeText: true },
    { no: 3, label: "その他", freeText: true },
    { no: 4, label: "判定不能", freeText: false },
  ],
  recheck: [
    { no: 1, label: "今も正しい（改定・改選後も変わらない／直さなくてよい）", freeText: false },
    { no: 2, label: "直す必要がある（足りない条件・変わった内容）", freeText: true },
    { no: 3, label: "その他", freeText: true },
    { no: 4, label: "判定不能", freeText: false },
  ],
  ignored: [
    { no: 1, label: "知識が正しい（新人の取り忘れ）", freeText: false },
    { no: 2, label: "この状況には当てはまらない（足りない条件）", freeText: true },
    { no: 3, label: "その他", freeText: true },
    { no: 4, label: "判定不能", freeText: false },
  ],
  disposal: [
    { no: 1, label: "廃棄する", freeText: false },
    { no: 2, label: "廃棄しない", freeText: false },
    { no: 3, label: "その他", freeText: true },
    { no: 4, label: "判定不能", freeText: false },
  ],
};

export type DigestEntry = {
  itemId: string;
  kind: ItemKind;
  knowledgeId: string;
  summary: string;
  submissionId: string | null;
  reason: ItemReason;
  choices: Choice[];
  /** miss のみ：確かめ直しの答えが、この外れの確認の答えを待っている（v21。再度の通知） */
  waitingRecheck?: boolean;
};

/** 最新の整理のまとめ（未回答の項目だけ）。ベテラン本人のメンター（F6）が言い換えて届ける */
export function buildDigest(deps: ReviewDeps): { reviewId: string | null; items: DigestEntry[] } {
  const latest = deps.db.select().from(reviews).orderBy(desc(reviews.ranAt)).limit(1).get();
  if (!latest) return { reviewId: null, items: [] };
  const rows = deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.reviewId, latest.reviewId), isNull(digestItems.answer)))
    .all()
    .sort((a, b) => (a.kind + a.knowledgeId + (a.submissionId ?? "") < b.kind + b.knowledgeId + (b.submissionId ?? "") ? -1 : 1));
  return {
    reviewId: latest.reviewId,
    items: rows.map((r) => ({
      itemId: r.itemId,
      kind: r.kind,
      knowledgeId: r.knowledgeId,
      summary: readKnowledge(deps.store, r.knowledgeId)?.summary ?? "",
      submissionId: r.submissionId,
      reason: JSON.parse(r.reason) as ItemReason,
      choices: CHOICES[r.kind],
      ...(r.kind === "miss" ? { waitingRecheck: heldRecheck(deps, r.knowledgeId).length > 0 } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// 回答の反映

export type AnswerOutcome =
  | { status: "duplicate" }
  | { status: "stale" }
  /** recheck：同じ会議の外れの確認の答えを待っている（v21） */
  | { status: "held" }
  | { status: "applied"; candidateId?: string; notify?: { submissionId: string; knowledgeId: string; message: "取り忘れだった" } };

export type Notification = { itemId: string; submissionId: string; knowledgeId: string; message: "取り忘れだった" };

/** 新人のメンターにまだ渡していない「取り忘れだった」（反映済みの ignored 回答 1）。直接の回答でも拾い直しでも同じ経路で取る */
export function pendingNotifications(deps: ReviewDeps): Notification[] {
  return deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.kind, "ignored"), eq(digestItems.answer, 1), eq(digestItems.applied, true), isNull(digestItems.notifiedAt)))
    .all()
    .map((r) => ({ itemId: r.itemId, submissionId: r.submissionId ?? "", knowledgeId: r.knowledgeId, message: "取り忘れだった" as const }));
}

/** 通知を渡し終えたら呼ぶ */
export function markNotified(deps: ReviewDeps, itemId: string, now: string): void {
  assertTime(now, "now");
  deps.db.update(digestItems).set({ notifiedAt: now }).where(eq(digestItems.itemId, itemId)).run();
}

/** 回答を記録し、すぐ反映する。失敗しても整理の手順 0 で拾い直す */
export function answerItem(
  deps: ReviewDeps,
  input: { itemId: string; answer: 1 | 2 | 3 | 4; freeText?: string },
  now: string,
): AnswerOutcome {
  assertTime(now, "now");
  const row = deps.db.select().from(digestItems).where(eq(digestItems.itemId, input.itemId)).get();
  if (!row) throw new Error(`未知の項目: ${input.itemId}`);
  if (row.answer !== null) return { status: "duplicate" }; // round-4 X-19
  deps.db
    .update(digestItems)
    .set({ answer: input.answer, freeText: input.freeText ?? null, answeredAt: now, applied: false })
    .where(eq(digestItems.itemId, input.itemId))
    .run();
  // 最新の会議に載っていない古い項目への回答は記録だけ（round-15 X-58）。回答が届いた時点で確かめる（v21）
  const latest = deps.db.select().from(reviews).orderBy(desc(reviews.ranAt)).limit(1).get();
  if (latest && row.reviewId !== latest.reviewId) {
    deps.db.update(digestItems).set({ stale: true }).where(eq(digestItems.itemId, input.itemId)).run();
    return { status: "stale" };
  }
  return reflect(deps, input.itemId, now);
}

const marker = (itemId: string) => `<!-- digest-item: ${itemId} -->`;

/** その項目の回答から作った（書き足した）候補の id */
function findCandidate(deps: ReviewDeps, relatesTo: string, itemId: string): string | null {
  for (const m of listKnowledge(deps.store)) {
    if (m.relates_to !== relatesTo) continue;
    if (m.source_event.ref === itemId || readBody(deps.store, m.id).includes(marker(itemId))) return m.id;
  }
  return null;
}

/** 修正版の候補を作る。同じ relates_to の未検証の候補があれば書き足す（round-9 C-44）。同じ項目では 1 回だけ */
function ensureCandidate(deps: ReviewDeps, orig: KnowledgeMeta, itemId: string, freeText: string | null, now: string): string {
  const done = findCandidate(deps, orig.id, itemId);
  if (done) return done;
  const text = `ベテランの回答（レセメン会議）：${freeText?.trim() || "（記述なし）"}\n\n${marker(itemId)}`;
  const open = listKnowledge(deps.store).find((m) => m.relates_to === orig.id && m.status === "未検証");
  if (open) {
    appendBody(deps.store, open.id, text);
    return open.id;
  }
  const created = createKnowledge(
    deps.store,
    {
      layer: "ベテラン",
      slug: `fix-${itemId.slice(0, 12)}`,
      summary: fitSummary("", orig.summary, "（修正の候補）"),
      body: `元の知識: ${orig.id}\n\n${text}`,
      source: { type: "エスカレーション", ref: itemId },
      relates_to: orig.id,
      match: orig.match,
      // 近似の条件と向きも引き継ぐ（round-12 X-49）
      polarity: orig.polarity,
      matchApprox: orig.matchApprox,
      conditionNote: orig.conditionNote,
    },
    now,
  );
  return created.id;
}

/** 回答の反映。順番は「状態の遷移 → 候補 → applied=true」で、どこで止まっても拾い直しで二重にならない */
function reflect(deps: ReviewDeps, itemId: string, now: string): AnswerOutcome {
  const row = deps.db.select().from(digestItems).where(eq(digestItems.itemId, itemId)).get();
  if (!row || row.answer === null) throw new Error(`回答のない項目: ${itemId}`);
  if (row.stale) return { status: "stale" };
  const meta = readKnowledge(deps.store, row.knowledgeId);
  const markStale = (): AnswerOutcome => {
    deps.db.update(digestItems).set({ stale: true }).where(eq(digestItems.itemId, itemId)).run();
    return { status: "stale" };
  };
  if (!meta) return markStale();

  // 途中まで反映済みか（history に項目 id があれば遷移は済んでいる。round-10 C-47）
  const transitioned = meta.history.some((h) => h.basis?.itemId === itemId);
  // 候補まで作り終えていれば、それも途中まで反映済みとみなす（round-11 C-54）
  const progressed = transitioned || (row.answer === 2 && findCandidate(deps, meta.id, itemId) !== null);
  if (!progressed) {
    if (snapshotOf(deps, meta, now, row.kind) !== row.snapshot) return markStale();
    if (row.kind === "recheck") {
      // 同じ会議の外れの確認を優先する（審査支払機関が上位。v21。round-15 C-60）
      const since = (JSON.parse(row.snapshot) as { status_since: string }).status_since;
      const misses = deps.db
        .select()
        .from(digestItems)
        .where(and(eq(digestItems.kind, "miss"), eq(digestItems.knowledgeId, meta.id), eq(digestItems.stale, false)))
        .all()
        .filter((m) => (JSON.parse(m.snapshot) as { status_since: string }).status_since === since);
      if (misses.some((m) => m.answer === 2 && m.applied)) return markStale();
      if (misses.some((m) => !m.applied)) return { status: "held" };
    }
    if (row.kind === "ignored") {
      if (meta.status === "保管") return markStale(); // v16 ユーザー判断
      const sub = deps.db.select().from(submissions).where(eq(submissions.submissionId, row.submissionId ?? "")).get();
      if (!sub || sub.superseded || isClosed(deps, row.submissionId ?? "", row.knowledgeId)) return markStale();
    }
  }

  const basis: Basis = { itemId };
  const out: AnswerOutcome & { status: "applied" } = { status: "applied" };
  const a = row.answer;
  if (row.kind === "miss") {
    // 外れの確認（v20）。1 は applied=true で「会議で扱った」になる。3・4 は記録だけ
    if (a === 2) {
      const reason = JSON.parse(row.reason) as ItemReason;
      if (!transitioned && reason.kind === "miss") {
        const b: Basis = { ...basis, submissionIds: reason.misses.map((m) => m.submissionId), kubun: [...new Set(reason.misses.flatMap((m) => m.kubun))].sort() };
        // 承認済みは要再検証に、要再検証は停止に（v21）
        if (meta.status === "承認済み") applyEvent(deps.store, meta.id, { type: "COUNTER_EXAMPLE" }, now, b);
        else if (meta.status === "要再検証") applyEvent(deps.store, meta.id, { type: "RECHECK_FAIL" }, now, b);
      }
      out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now);
    }
  } else if (row.kind === "recheck") {
    if (a === 1 && !transitioned) applyEvent(deps.store, meta.id, { type: "RECHECK_PASS", via: "veteran" }, now, basis);
    if (a === 2) {
      if (!transitioned) applyEvent(deps.store, meta.id, { type: "RECHECK_FAIL" }, now, basis);
      out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now);
    }
  } else if (row.kind === "ignored") {
    if (a === 1) {
      if (meta.status === "承認済み" || meta.status === "要再検証") applyEvent(deps.store, meta.id, { type: "USED" }, now);
      out.notify = { submissionId: row.submissionId ?? "", knowledgeId: meta.id, message: "取り忘れだった" };
    }
    if (a === 2) out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now);
  } else {
    if (a === 1 && !transitioned) {
      const reason = row.freeText?.trim() || "レセメン会議でベテランが廃棄を承認";
      applyEvent(deps.store, meta.id, { type: "DISPOSAL_APPROVE", reason }, now, basis);
    }
    if (a === 2 && !transitioned) applyEvent(deps.store, meta.id, { type: "DISPOSAL_REJECT" }, now, basis);
  }
  deps.db.update(digestItems).set({ applied: true }).where(eq(digestItems.itemId, itemId)).run();
  if (row.kind === "ignored" && a === 2) recount(deps, meta.id);
  // 外れの確認を反映したら、待っていた確かめ直しの答えを続けて反映する（v21）
  if (row.kind === "miss") for (const r of heldRecheck(deps, meta.id)) reflect(deps, r.itemId, now);
  return out;
}
