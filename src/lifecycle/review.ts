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
  writeRevisionChecks,
  acceptRevisionDiffs,
  pendingRevisionDiffs,
  type StoreOptions,
} from "./store";
import { assertTime, canonicalTime, ms } from "./time";
import { evaluateTriggers, triggersOf } from "./triggers";
import type { Basis, CodePair, KnowledgeMeta, LifecycleEvent, Polarity, TriggerKind } from "./types";
import { PAIR_NOTE_MAX } from "./store";
import { conflictDocs, conflictKeys, docKey } from "../official/match";
import type { OfficialDoc, OfficialInput } from "../official/types";
import { badRequest, notFound } from "../server/errors";
import { fillLocal, LOCAL_PAIR_TEXT } from "../messages";
import { TABLE } from "../generic/tensuhyo";

export type ReviewDeps = {
  db: Db;
  store: StoreOptions;
  calendar: Calendar;
  /** 制度層の知識が「関係あり」かを決める、エンジンの各ルールの kubun。提出の診療年月の版から取る */
  ruleKubun: (ruleId: string, yearMonth: string) => string[];
  /**
   * 診療年月に当たる改定の版があるか（任意。渡すのは本番の配線だけ）。渡されなければ、すべての提出を版ありとして扱う。
   * 版のない提出は、整理の最初に対象から外す（拾い直し・数え直し・議題のすべてで無いものとして扱う。§4-4 手順 1）
   */
  hasRevision?: (yearMonth: string) => boolean;
  /**
   * 背反の組の院内の知識（match.codePair）の、改定の前後でその組に差が出た項目（任意。渡すのは本番の配線。design.md §14-4）。
   * revisionDate は改定日。差がなければ空、改定後の 1 枚・版の行がまだなければ "pending"（保留：要再検証にしない。C-181）。
   * 改定前の 1 枚・EM の行がなくて比べられないときは、その旨の文 1 つ（要再検証にする。round-43 C-202・設計 v27）。渡されなければ判定しない
   */
  localRevision?: (pair: CodePair, revisionDate: string) => string[] | "pending";
  /**
   * 公的情報レジストリ（任意。渡すのは本番の配線）。渡されたときだけ、トリガー④を判定し、
   * 議題の snapshot と理由に、矛盾の恐れになる公的文書を載せる（§4-3・§4-4）
   */
  official?: OfficialInput;
  /**
   * このクリニックでは使わない請求か（任意。2026-11-22 利用者の判断「印で除外する」）。真になる請求の提出は、版のない提出と同じく、
   * 整理の最初に対象から外す（拾い直し・数え直し・議題のすべてで無いものとして扱う）。行は消さない
   */
  excludedClaim?: (claimId: string) => boolean;
  /**
   * 前回の整理として数えてよい整理か（任意。ranAt は正規形の時刻）。渡されなければ、どの整理も数える。
   * 未定から real を選んだクリニックで、デモのときに未来の日付で回した整理を、前回の整理・最新の議題として使わないために渡す（反証 round-44 #5）
   */
  validReview?: (ranAt: string) => boolean;
};

/** 前回（最新）の整理。validReview に当たらない整理は飛ばす。会議の日の判定・議題・回答の新しさの判定が使う */
export function latestReview(deps: Pick<ReviewDeps, "db" | "validReview">) {
  const valid = deps.validReview;
  if (!valid) return deps.db.select().from(reviews).orderBy(desc(reviews.ranAt)).limit(1).get();
  return deps.db.select().from(reviews).orderBy(desc(reviews.ranAt)).all().find((r) => valid(r.ranAt));
}

/** 版のない提出の id（昇順）。hasRevision を渡されていなければ空。整理の記録（reviews.skipped）と議題の件数に使う */
function noRevisionSubmissions(deps: ReviewDeps): string[] {
  const has = deps.hasRevision;
  if (!has) return [];
  return deps.db
    .select()
    .from(submissions)
    .all()
    .filter((s) => !has(s.yearMonth))
    .map((s) => s.submissionId)
    .sort();
}

/** 整理の対象から外す提出の id（昇順）：版のない提出と、このクリニックでは使わない請求（excludedClaim）の提出 */
function skippedSubmissions(deps: ReviewDeps): string[] {
  const has = deps.hasRevision;
  const excluded = deps.excludedClaim;
  if (!has && !excluded) return [];
  return deps.db
    .select()
    .from(submissions)
    .all()
    .filter((s) => (has !== undefined && !has(s.yearMonth)) || (excluded !== undefined && excluded(s.claimId)))
    .map((s) => s.submissionId)
    .sort();
}

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

/**
 * 「関係あり」の区分：ruleId を持つ知識は層にかかわらずルールの kubun、それ以外は kubunAll（round-3 C-17、v20。round-14 X-55）。
 * ルールの kubun は、その提出の診療年月の版から取る（版で対象区分が変わるため、提出ごとに計算する）
 */
function relevantKubun(m: KnowledgeMeta, deps: ReviewDeps, yearMonth: string): string[] {
  return m.match.ruleId !== undefined ? deps.ruleKubun(m.match.ruleId, yearMonth) : (m.match.kubunAll ?? []);
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
  // 版のない提出は観測に入れない（ruleKubun も呼ばない）。数え直し・議題の除外はここ 1 か所で効く
  const skipped = new Set(skippedSubmissions(deps));
  const rows = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.knowledgeId, meta.id), eq(submissions.superseded, false)))
    .all();
  const out: Observation[] = [];
  for (const r of rows) {
    if (skipped.has(r.submissions.submissionId)) continue;
    const res = effectiveResult(deps.db, r.submissions.submissionId);
    if (!res) continue;
    const rel = relevantKubun(meta, deps, r.submissions.yearMonth);
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
  // 版のない提出への ignored の回答 2 は、反映済みでも外れに数えない
  const skipped = new Set(skippedSubmissions(deps));
  const ignoredMisses = new Set(
    deps.db
      .select()
      .from(digestItems)
      .where(and(eq(digestItems.kind, "ignored"), eq(digestItems.knowledgeId, id), eq(digestItems.answer, 2), eq(digestItems.applied, true)))
      .all()
      .map((r) => r.submissionId)
      .filter((sid) => sid === null || !skipped.has(sid)),
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
  /** localRevision＝改定の棚卸で、要再検証にしたあと、結果（revision_checks）を残す前 */
  onStep?: (step: "recover" | "recount" | "trigger" | "localRevision" | "digest", knowledgeId?: string) => void;
};

/** 会議の整理を回す。何度回しても同じ結果になる（途中で止まっても、もう一度回せばよい） */
export function meetingReview(deps: ReviewDeps, now: string, hooks: ReviewHooks = {}): { reviewId: string } {
  assertTime(now, "now");
  // 同じ瞬間なら表記（+09:00／Z）が違っても同じ整理（v16 §3）
  const ranAt = canonicalTime(now);
  const reviewId = `review-${ranAt}`;

  // 版のない提出を分ける（§4-4 手順 1）。この後の拾い直し・数え直し・議題は、どれも同じ判定（skippedSubmissions。使わない請求の提出も含む）で除く。
  // 整理の記録に残すのは、版のない提出だけ（議題の末尾の件数の文言が「版がない」なので）
  const skipped = noRevisionSubmissions(deps);

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
  for (const fired of evaluateTriggers(listKnowledge(deps.store), now, deps.calendar, deps.official)) {
    hooks.onStep?.("trigger", fired.knowledgeId);
    // ④ では、未確認だった文書の鍵を根拠に残す
    const basis: Basis = { trigger: triggerOf(fired.event), ...(fired.officialIds ? { officialIds: fired.officialIds } : {}) };
    applyEvent(deps.store, fired.knowledgeId, fired.event, now, basis);
  }

  // 手順 2 の続き：背反の組の院内の知識の改定の棚卸（design.md §14-4）。改定日に承認済みだった知識ごとに、改定の前後でその組に差が出たかを見て、差が出た知識だけを要再検証にする（TRIGGER{localRevision}）。
  // 棚卸の記録（revision_checks）は知識の状態と別に持つ：保留（pending）は、別の理由で承認し直しても残り、比べる 1 枚がそろったら比べる（round-43 codex #2）
  if (deps.localRevision) {
    const d = latestRevision(deps.calendar, now);
    for (const meta of listKnowledge(deps.store)) {
      const pair = meta.match.codePair;
      if (!pair || meta.status === "保管") continue;
      const checks = { ...meta.revision_checks };
      const diffs = { ...meta.revision_diffs };
      // 前の整理が、要再検証にしたあと結果を残す前に止まったときは、history の TRIGGER{localRevision}（根拠の改定日）から結果を戻す（やり直しても同じ結果。round-45 codex #2）
      let changed = false;
      for (const h of meta.history)
        if (h.event === "TRIGGER{localRevision}" && h.basis?.revisionDate && checks[h.basis.revisionDate] !== "changed") {
          checks[h.basis.revisionDate] = "changed";
          changed = true;
        }
      // 見る改定日：直近の改定日（その日に承認済みだった知識だけ。改定の後に承認した知識は、承認した人が改定後のデータで見ている）と、保留のままの改定日
      // 承認済みでないあいだに出た差（diff）は、差を見せる承認の道（議題・承認のキュー）で accepted になる。差を見せずに承認済みに戻ったときは、残した差で要再検証にする
      const dates = [...new Set([...(d !== null && checks[d] === undefined && approvedAt(meta, d) ? [d] : []), ...Object.keys(checks).filter((k) => checks[k] === "pending" || (checks[k] === "diff" && meta.status === "承認済み"))])].sort();
      for (const date of dates) {
        hooks.onStep?.("trigger", meta.id);
        const r = checks[date] === "diff" ? (diffs[date] ?? []) : deps.localRevision(pair, date);
        // 承認済みでないあいだ（要再検証・未検証・停止など）に差が出たら、差の中身を残す（diff。承認し直す議題に出す。design.md §14-4 v28）
        const next = r === "pending" ? "pending" : r.length === 0 ? "same" : meta.status === "承認済み" ? "changed" : "diff";
        if (next === "diff") diffs[date] = r as string[];
        if (next === "changed") delete diffs[date];
        if (checks[date] !== next || next === "diff") {
          checks[date] = next;
          changed = true;
        }
        if (next === "changed") {
          // 遷移を先にして、結果はあとで残す。間で止まっても、次の整理が history から結果を戻すので、二度要再検証にしない
          applyEvent(deps.store, meta.id, { type: "TRIGGER", trigger: "localRevision" }, now, { trigger: "localRevision", codePair: pair, changes: r as string[], revisionDate: date });
          break;
        }
      }
      hooks.onStep?.("localRevision", meta.id);
      if (changed) writeRevisionChecks(deps.store, meta.id, checks, diffs);
    }
  }

  // 手順 3：議題
  hooks.onStep?.("digest");
  buildItems(deps, reviewId, now);
  // 整理を記録するのは最後（途中で止まった整理が、議題と次の会議の日の判定を隠さないように。round-14 X-56）
  deps.db.insert(reviews).values({ reviewId, ranAt, skipped: JSON.stringify(skipped) }).onConflictDoNothing().run();
  // 待たせていた miss が今回の議題から消えた recheck の答えを反映し、議題を作り直す（v21 補足。round-16 C-61）
  const held = deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.kind, "recheck"), eq(digestItems.applied, false), eq(digestItems.stale, false)))
    .all()
    .filter((r) => r.answer !== null);
  if (held.length > 0) {
    for (const r of held) reflect(deps, r.itemId, now);
    buildItems(deps, reviewId, now);
  }
  return { reviewId };
}

/** その時刻に承認済みだったか（history で、その時刻までの最後の遷移の行き先） */
function approvedAt(meta: KnowledgeMeta, at: string): boolean {
  const last = meta.history.filter((h) => ms(h.at) <= ms(at)).at(-1);
  return last?.to === "承認済み";
}

function triggerOf(e: LifecycleEvent): TriggerKind {
  if (e.type === "TRIGGER") return e.trigger;
  if (e.type === "IDLE_EXPIRED") return "idle";
  throw new Error(`トリガーでないイベント: ${e.type}`);
}

// ---------------------------------------------------------------------------
// まとめの項目

type ItemKind = "miss" | "recheck" | "ignored" | "disposal";

/** 直近の改定日・改選日。トリガーと同じ規則（元の知識の層を引き継ぐ。round-16 C-62・X-60） */
function basisDate(deps: ReviewDeps, meta: KnowledgeMeta, now: string): string | null {
  const t = triggersOf(meta, new Map(listKnowledge(deps.store).map((m) => [m.id, m])));
  if (t.revision) return latestRevision(deps.calendar, now);
  if (t.reappointment) return latestReappointment(deps.calendar, meta.match.payer, meta.match.prefecture, now);
  return null;
}

/**
 * 整理時点の snapshot。miss・recheck・disposal は状態・版・基準日、ignored は版だけ（round-11 C-51）。miss の外れは入れない。
 * 公的情報レジストリを渡されたときは、その時点で矛盾の恐れになる文書の鍵（officialKeys）も入れる。
 * 回答のときに作り直して比べるので、議題を作った後に文書が増えても減っても、古い回答として照合に落ちる（v22。X-66）
 */
function snapshotOf(deps: ReviewDeps, meta: KnowledgeMeta, now: string, kind: ItemKind): string {
  if (kind === "ignored") return JSON.stringify({ rev: meta.rev });
  return JSON.stringify({
    status: meta.status,
    status_since: meta.status_since,
    rev: meta.rev,
    basisDate: basisDate(deps, meta, now),
    ...(deps.official ? { officialKeys: conflictKeys(meta, deps.official, now) } : {}),
  });
}

/** snapshot に載っていた公的文書の鍵（段 4 より前に作った項目にはない） */
const officialKeysOf = (snapshot: string): string[] => (JSON.parse(snapshot) as { officialKeys?: string[] }).officialKeys ?? [];

/** 議題に載せる公的文書（要旨とリンク。点数・金額の欄を持たない）。seen は、その知識について会議で確認済みか */
export type OfficialRef = Pick<OfficialDoc, "id" | "kind" | "issuer" | "number" | "issuedOn" | "url" | "stance" | "summary"> & { seen: boolean };

/**
 * 理由の (b)：整理の時点で矛盾の恐れになる公的文書のすべて（確認済みの文書も、要再検証の間に入った文書も含む。C-64）。
 * 近似の知識には、条件の注記（conditionNote）を添える。注記に照らして本当に矛盾かは、責任者が読んで決める（C-73）
 */
function officialReason(deps: ReviewDeps, meta: KnowledgeMeta, now: string): { official?: OfficialRef[]; conditionNote?: string } {
  if (!deps.official) return {};
  const docs = conflictDocs(meta, deps.official, now);
  if (docs.length === 0) return {};
  return {
    official: docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      issuer: d.issuer,
      number: d.number,
      issuedOn: d.issuedOn,
      url: d.url,
      stance: d.stance,
      summary: d.summary,
      seen: meta.official_seen.includes(docKey(d)),
    })),
    ...(meta.matchApprox && meta.conditionNote ? { conditionNote: meta.conditionNote } : {}),
  };
}

/** 議題に載せる外れ（v20） */
export type MissEntry = { submissionId: string; resultId: string; kubun: string[] };

/** 同じ知識を同じ rev で適用したほかの提出（v20。並べるだけで、請求には触れない） */
export type SameApplied = { submissionId: string; claimId: string; yearMonth: string; result: Outcome | "結果待ち" };

export type ItemReason =
  | { kind: "miss"; misses: MissEntry[]; sameApplied: SameApplied[] }
  | { kind: "recheck"; event: string; submissionIds?: string[]; kubun?: string[]; trigger?: TriggerKind; official?: OfficialRef[]; conditionNote?: string; claimId?: string; codePair?: CodePair; changes?: string[]; revisionDiffs?: Record<string, string[]> }
  | { kind: "ignored"; removedKubun: string[] }
  | { kind: "disposal"; event: string; candidateId?: string | null; official?: OfficialRef[]; conditionNote?: string; revisionDiffs?: Record<string, string[]> };

function lastEntryInto(meta: KnowledgeMeta, status: string) {
  return [...meta.history].reverse().find((h) => h.to === status);
}

function recheckReason(deps: ReviewDeps, meta: KnowledgeMeta, now: string): ItemReason {
  const e = lastEntryInto(meta, "要再検証");
  const b = e?.basis ?? {};
  // 背反の組の知識（design.md §14-4）：返戻の請求 id と組・改定で差が出た項目
  return { kind: "recheck", event: e?.event ?? "", submissionIds: b.submissionIds, kubun: b.kubun, trigger: b.trigger, ...officialReason(deps, meta, now), ...(b.claimId ? { claimId: b.claimId } : {}), ...(b.codePair ? { codePair: b.codePair } : {}), ...(b.changes ? { changes: b.changes } : {}), ...diffsReason(meta) };
}

/** 承認し直す議題に並べる、承認済みでないあいだに出た改定の差（design.md §14-4 v28。あるときだけ） */
function diffsReason(meta: KnowledgeMeta): { revisionDiffs?: Record<string, string[]> } {
  const d = pendingRevisionDiffs(meta);
  return Object.keys(d).length > 0 ? { revisionDiffs: d } : {};
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
  const skipped = new Set(skippedSubmissions(deps));
  const sameApplied = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.knowledgeId, meta.id), eq(applications.rev, meta.rev), eq(applications.role, "final"), eq(submissions.superseded, false)))
    .all()
    .filter((r) => !missIds.has(r.submissions.submissionId) && !skipped.has(r.submissions.submissionId))
    .map((r) => ({
      submissionId: r.submissions.submissionId,
      claimId: r.submissions.claimId,
      yearMonth: r.submissions.yearMonth,
      result: effectiveResult(deps.db, r.submissions.submissionId)?.outcome ?? ("結果待ち" as const),
    }))
    .sort((x, y) => (x.submissionId < y.submissionId ? -1 : 1));
  return { kind: "miss", misses, sameApplied };
}

function disposalReason(deps: ReviewDeps, meta: KnowledgeMeta, now: string): ItemReason {
  const e = lastEntryInto(meta, "停止");
  const b = e?.basis ?? {};
  if (e?.event === "RECHECK_FAIL") {
    return { kind: "disposal", event: e.event, candidateId: b.itemId ? findCandidate(deps, meta.id, b.itemId) : null, ...officialReason(deps, meta, now), ...diffsReason(meta) };
  }
  return { kind: "disposal", event: e?.event ?? "", ...officialReason(deps, meta, now), ...diffsReason(meta) };
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
    if (meta.status === "要再検証" && heldRecheck(deps, meta.id).length === 0) item = { kind: "recheck", reason: recheckReason(deps, meta, now) };
    else if (meta.status === "停止") item = { kind: "disposal", reason: disposalReason(deps, meta, now) };
    if (item) upsertItem(deps, reviewId, { ...item, knowledgeId: meta.id, submissionId: null, snapshot: snapshotOf(deps, meta, now, item.kind) });
  }
  const ignored = deps.db
    .select()
    .from(applications)
    .innerJoin(submissions, eq(applications.submissionId, submissions.submissionId))
    .where(and(eq(applications.role, "ignored"), eq(submissions.superseded, false)))
    .all();
  const skipped = new Set(skippedSubmissions(deps));
  for (const r of ignored) {
    const { submissionId, knowledgeId } = r.applications;
    if (skipped.has(submissionId)) continue;
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
    { no: 1, label: "今も正しい（改定・改選・公的文書の後も変わらない／直さなくてよい）", freeText: false },
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
  /** 背反の組の知識（match.codePair）だけ：組と、今の向き・条件の文。回答 2 では、修正版の向きと条件の文を回答で入れる（design.md §14-1。X-118） */
  pair?: { codePair: CodePair; polarity: Polarity; conditionNote: string };
};

/** 最新の整理のまとめ（未回答の項目だけ）。ベテラン本人のメンター（F6）が言い換えて届ける */
export function buildDigest(deps: ReviewDeps): { reviewId: string | null; items: DigestEntry[]; skippedCount?: number } {
  const latest = latestReview(deps);
  if (!latest) return { reviewId: null, items: [] };
  const skippedCount = (JSON.parse(latest.skipped) as string[]).length;
  const rows = deps.db
    .select()
    .from(digestItems)
    .where(and(eq(digestItems.reviewId, latest.reviewId), isNull(digestItems.answer)))
    .all()
    .sort((a, b) => (a.kind + a.knowledgeId + (a.submissionId ?? "") < b.kind + b.knowledgeId + (b.submissionId ?? "") ? -1 : 1));
  // このクリニックでは使わない知識（deps.store.excluded）の項目は、議題に出さない（行は消さない。2026-11-22 利用者の判断）
  const shown = rows.filter((r) => {
    const m = deps.store.excluded ? readKnowledge(deps.store, r.knowledgeId) : undefined;
    return !(m && deps.store.excluded?.(m));
  });
  return {
    reviewId: latest.reviewId,
    items: shown.map((r) => ({
      itemId: r.itemId,
      kind: r.kind,
      knowledgeId: r.knowledgeId,
      summary: readKnowledge(deps.store, r.knowledgeId)?.summary ?? "",
      ...((m) => (m?.match.codePair ? { pair: { codePair: m.match.codePair, polarity: m.polarity, conditionNote: m.conditionNote ?? "" } } : {}))(readKnowledge(deps.store, r.knowledgeId)),
      submissionId: r.submissionId,
      reason: JSON.parse(r.reason) as ItemReason,
      choices: CHOICES[r.kind],
      ...(r.kind === "miss" ? { waitingRecheck: heldRecheck(deps, r.knowledgeId).length > 0 } : {}),
    })),
    // 版がなくて整理の対象から外した提出の件数（あるときだけ。議題の末尾に件数だけを出す）
    ...(skippedCount > 0 ? { skippedCount } : {}),
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

/**
 * 回答を記録し、すぐ反映する。失敗しても整理の手順 0 で拾い直す。
 * 背反の組の知識（match.codePair）を回答 2 で直すときは、修正版の向き（polarity）と条件の文（conditionNote）が要る（元からコピーしない。design.md §14-1。X-118）。
 * それ以外の知識・回答には付けない
 */
export function answerItem(
  deps: ReviewDeps,
  input: { itemId: string; answer: 1 | 2 | 3 | 4; freeText?: string; polarity?: Polarity; conditionNote?: string },
  now: string,
): AnswerOutcome {
  assertTime(now, "now");
  const row = deps.db.select().from(digestItems).where(eq(digestItems.itemId, input.itemId)).get();
  if (!row) throw notFound(`未知の項目: ${input.itemId}`);
  if (row.answer !== null) return { status: "duplicate" }; // round-4 X-19
  const pair = readKnowledge(deps.store, row.knowledgeId)?.match.codePair !== undefined;
  // 修正版の候補を作るのは、廃棄提案以外の項目の回答 2（disposal の 2 は「廃棄しない」）
  const fix = pair && input.answer === 2 && row.kind !== "disposal";
  if (!fix && (input.polarity !== undefined || input.conditionNote !== undefined)) throw badRequest("向きと条件の文は、背反の組の知識を「直す必要がある」と答えるときだけ付けます");
  const note = input.conditionNote?.trim() ?? "";
  if (fix && (input.polarity === undefined || note === "" || note.length > PAIR_NOTE_MAX)) throw badRequest(`背反の組の知識を直すときは、修正版の扱いと、条件（1〜${PAIR_NOTE_MAX} 字）を入れてください`);
  // 最新の会議に載っていない古い項目への回答は記録だけ（round-15 X-58）。回答が届いた時点で確かめ、
  // 回答と stale の印を同じ書き込みで残す（途中で止まっても拾い直しで反映されない。round-16 X-62）
  const latest = latestReview(deps);
  const old = latest !== undefined && row.reviewId !== latest.reviewId;
  deps.db
    .update(digestItems)
    .set({ answer: input.answer, freeText: input.freeText ?? null, answeredAt: now, applied: false, stale: old, ...(fix ? { polarity: input.polarity, conditionNote: note } : {}) })
    .where(eq(digestItems.itemId, input.itemId))
    .run();
  if (old) return { status: "stale" };
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

/**
 * 修正版の候補を作る。同じ relates_to の未検証の候補があれば書き足す（round-9 C-44）。同じ項目では 1 回だけ。
 * 背反の組の知識（match.codePair）は、修正版の向きと条件の文を回答の値（fix）にする（元からコピーしない。書き足すときも置き換える。design.md §14-1。X-118）
 */
function ensureCandidate(deps: ReviewDeps, orig: KnowledgeMeta, itemId: string, freeText: string | null, now: string, fix: { polarity: Polarity | null; conditionNote: string | null } = { polarity: null, conditionNote: null }): string {
  const done = findCandidate(deps, orig.id, itemId);
  // 候補がもうある（前の反映が、候補を作ったあと保留を写す前に止まった）ときも、元の未済の保留を写す。写す処理は何度呼んでも同じ結果（round-46 C-210）
  if (done) {
    inheritRevisionChecks(deps, orig, done, now);
    return done;
  }
  const over = orig.match.codePair !== undefined ? { polarity: fix.polarity, conditionNote: fix.conditionNote } : null;
  if (over && (over.polarity === null || !over.conditionNote)) throw new Error(`背反の組の知識の修正版に、回答の向きと条件の文がない: ${itemId}`);
  const pairOver = over ? { polarity: over.polarity!, conditionNote: over.conditionNote! } : undefined;
  // 背反の組の知識は、要約と本文に、実際に使われる扱いと条件を出す（承認する人が、使われる向きを見て承認できるように。round-43 codex #3）
  const pair = orig.match.codePair;
  const pairSummary = pair && pairOver ? fitSummary("", fillLocal(pairOver.polarity === "allow" ? LOCAL_PAIR_TEXT.summaryAllow : LOCAL_PAIR_TEXT.summaryAvoid, { a: pair.a, b: pair.b, table: TABLE.haihan[pair.tani] }), "（修正の候補）") : null;
  const pairLine = pairOver ? `${fillLocal(LOCAL_PAIR_TEXT.fixLine, { label: pairOver.polarity === "allow" ? LOCAL_PAIR_TEXT.allowLabel : LOCAL_PAIR_TEXT.avoidLabel, note: pairOver.conditionNote })}\n\n` : "";
  const text = `ベテランの回答（レセメン会議）：${freeText?.trim() || "（記述なし）"}\n\n${pairLine}${marker(itemId)}`;
  const open = listKnowledge(deps.store).find((m) => m.relates_to === orig.id && m.status === "未検証");
  if (open) {
    // 前の回答の「修正版の扱い」の行は置き換える（向きの食い違う 2 行を並べない。round-46 C-212）
    appendBody(deps.store, open.id, text, pairOver && pairSummary ? { ...pairOver, summary: pairSummary, dropLinePrefix: LOCAL_PAIR_TEXT.fixLine.split("{")[0] } : undefined);
    inheritRevisionChecks(deps, orig, open.id, now);
    return open.id;
  }
  const created = createKnowledge(
    deps.store,
    {
      layer: "ベテラン",
      slug: `fix-${itemId.slice(0, 12)}`,
      summary: pairSummary ?? fitSummary("", orig.summary, "（修正の候補）"),
      body: `元の知識: ${orig.id}\n\n${text}`,
      source: { type: "エスカレーション", ref: itemId },
      relates_to: orig.id,
      match: orig.match,
      // 近似の条件と向きも引き継ぐ（round-12 X-49）。背反の組の知識は、回答の値にする（X-118）
      polarity: pairOver?.polarity ?? orig.polarity,
      matchApprox: orig.matchApprox,
      conditionNote: pairOver?.conditionNote ?? orig.conditionNote,
    },
    now,
  );
  inheritRevisionChecks(deps, orig, created.id, now);
  return created.id;
}

/**
 * 背反の組の知識の修正版に、元の知識の済んでいない改定の棚卸を引き継ぐ（round-45 codex #1）：元の保留（pending）と、直近の改定日に元が承認済みで、まだ棚卸していないもの。
 * 修正版は改定の後に承認されるので、自分では棚卸の対象にならない。引き継いだ保留は、修正版が承認されたあとの整理で比べる
 */
function inheritRevisionChecks(deps: ReviewDeps, orig: KnowledgeMeta, candidateId: string, now: string): void {
  if (!orig.match.codePair) return;
  const from = orig.revision_checks ?? {};
  const d = latestRevision(deps.calendar, now);
  const owed = [...Object.keys(from).filter((k) => from[k] === "pending" || from[k] === "diff"), ...(d !== null && from[d] === undefined && approvedAt(orig, d) ? [d] : [])];
  if (owed.length === 0) return;
  const cand = readKnowledge(deps.store, candidateId);
  if (!cand) return;
  const checks = { ...cand.revision_checks };
  const diffs = { ...cand.revision_diffs };
  // 元で差が出ていた改定日は、差の中身ごと写す（修正版を承認するときに見せる。design.md §14-4 v28）
  for (const k of owed)
    if (checks[k] === undefined) {
      checks[k] = from[k] === "diff" ? "diff" : "pending";
      if (from[k] === "diff") diffs[k] = orig.revision_diffs?.[k] ?? [];
    }
  writeRevisionChecks(deps.store, candidateId, checks, diffs);
}

/** 議題の理由に並べた改定の差（revisionDiffs）の改定日を、済み（accepted）にする。理由に出ていない差は残す（差を見せずに承認したことになるので、あとの整理で要再検証にする） */
function acceptShownDiffs(deps: ReviewDeps, knowledgeId: string, reasonJson: string): void {
  const reason = JSON.parse(reasonJson) as ItemReason;
  const shown = (reason.kind === "recheck" || reason.kind === "disposal") && reason.revisionDiffs ? Object.keys(reason.revisionDiffs) : [];
  if (shown.length > 0) acceptRevisionDiffs(deps.store, knowledgeId, shown);
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
  // このクリニックでは使わない知識（store.excluded）は、回答があっても反映しない：状態・history を変えず、修正の候補も作らない（行も書き換えない。反証 round-44 #2）
  if (deps.store.excluded?.(meta)) return { status: "stale" };

  // 途中まで反映済みか（history に項目 id があれば遷移は済んでいる。round-10 C-47）
  const transitioned = meta.history.some((h) => h.basis?.itemId === itemId);
  // 候補まで作り終えていれば、それも途中まで反映済みとみなす（round-11 C-54）
  const progressed = transitioned || (row.answer === 2 && findCandidate(deps, meta.id, itemId) !== null);
  if (!progressed) {
    // 版のない提出を指す項目は反映しない（整理の手順 1 と同じ判定。候補も作らない。X-71）
    const skipped = new Set(skippedSubmissions(deps));
    if (skipped.size > 0) {
      if (row.kind === "ignored" && skipped.has(row.submissionId ?? "")) return markStale();
      const reason = JSON.parse(row.reason) as ItemReason;
      if (reason.kind === "miss" && reason.misses.some((m) => skipped.has(m.submissionId))) return markStale();
    }
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
      // 待たせるのは、最新の会議に載っている未回答の miss と、回答済みで未反映の miss だけ（v21 補足。round-16 C-61・X-61）
      const latest = latestReview(deps);
      const blocking = misses.filter((m) => !m.applied && (m.answer !== null || m.reviewId === latest?.reviewId));
      if (blocking.length > 0) return { status: "held" };
    }
    if (row.kind === "ignored") {
      if (meta.status === "保管") return markStale(); // v16 ユーザー判断
      const sub = deps.db.select().from(submissions).where(eq(submissions.submissionId, row.submissionId ?? "")).get();
      if (!sub || sub.superseded || isClosed(deps, row.submissionId ?? "", row.knowledgeId)) return markStale();
    }
  }

  const basis: Basis = { itemId };
  // 承認済みに戻す回答（recheck 1・disposal 2）では、項目に載っていた公的文書の鍵を確認済みに足し、根拠に残す（v22。§4-3）
  const officialKeys = officialKeysOf(row.snapshot);
  const seenBasis: Basis = officialKeys.length > 0 ? { ...basis, officialIds: officialKeys } : basis;
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
      out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now, { polarity: row.polarity, conditionNote: row.conditionNote });
    }
  } else if (row.kind === "recheck") {
    // 議題に並べた改定の差を見たうえで承認した → その改定の棚卸は済み（design.md §14-4 v28。何度やり直しても同じ）
    if (a === 1) acceptShownDiffs(deps, meta.id, row.reason);
    if (a === 1 && !transitioned) applyEvent(deps.store, meta.id, { type: "RECHECK_PASS", via: "veteran", officialKeys }, now, seenBasis);
    if (a === 2) {
      if (!transitioned) applyEvent(deps.store, meta.id, { type: "RECHECK_FAIL" }, now, basis);
      out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now, { polarity: row.polarity, conditionNote: row.conditionNote });
    }
  } else if (row.kind === "ignored") {
    if (a === 1) {
      if (meta.status === "承認済み" || meta.status === "要再検証") applyEvent(deps.store, meta.id, { type: "USED" }, now);
      out.notify = { submissionId: row.submissionId ?? "", knowledgeId: meta.id, message: "取り忘れだった" };
    }
    if (a === 2) out.candidateId = ensureCandidate(deps, meta, itemId, row.freeText, now, { polarity: row.polarity, conditionNote: row.conditionNote });
  } else {
    if (a === 1 && !transitioned) {
      const reason = row.freeText?.trim() || "レセメン会議でベテランが廃棄を承認";
      applyEvent(deps.store, meta.id, { type: "DISPOSAL_APPROVE", reason }, now, basis);
    }
    if (a === 2) acceptShownDiffs(deps, meta.id, row.reason);
    if (a === 2 && !transitioned) applyEvent(deps.store, meta.id, { type: "DISPOSAL_REJECT", officialKeys }, now, seenBasis);
  }
  deps.db.update(digestItems).set({ applied: true }).where(eq(digestItems.itemId, itemId)).run();
  if (row.kind === "ignored" && a === 2) recount(deps, meta.id);
  // 外れの確認を反映したら、待っていた確かめ直しの答えを続けて反映する（v21）
  if (row.kind === "miss") for (const r of heldRecheck(deps, meta.id)) reflect(deps, r.itemId, now);
  return out;
}
