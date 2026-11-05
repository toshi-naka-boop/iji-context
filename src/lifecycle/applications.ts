// 適用記録と提出結果の取り込み（design.md §4-4、v14〜v20）。結果は記録だけで、知識はレセメン会議で更新する
import { assertTime } from "./time";
import { createHash } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ClaimContext, ClaimLine } from "../engine/types";
import { applications, claimResults, submissions } from "../db/schema";
import { matchState, matches } from "./match";
import type { KnowledgeMeta } from "./types";

export type Db = BetterSQLite3Database<Record<string, unknown>>;

/** 1 回の評価（ctx と、そのときのエンジンの applied） */
export type Evaluation = { ctx: ClaimContext; applied: string[] };

export type Outcome = "通過" | "返戻" | "査定";
export type ResultKind = "原審査" | "保険者再審査" | "縦覧点検" | "突合点検" | "資格";

export type SubmissionResult = {
  resultId: string;
  submissionId: string;
  kind: ResultKind;
  outcome: Outcome;
  kubun: string[];
};

/** lines の正規化ハッシュ（並び順に依存しない） */
export function hashLines(lines: ClaimLine[]): string {
  const norm = lines
    .map((l) => ({ kubun: l.kubun, count: l.count, dates: [...l.dates].sort() }))
    .sort((a, b) => (a.kubun < b.kubun ? -1 : a.kubun > b.kubun ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

const isTarget = (m: KnowledgeMeta): boolean => m.status === "承認済み" || m.status === "要再検証";

/**
 * 提出確定を記録する。記録は提出確定のときに 1 回だけ書く（C-7、X-6）。
 * 戻り値は avoided になった知識の id（呼び出し側がそれぞれに USED を出す）。
 */
export function confirmSubmission(
  db: Db,
  input: {
    submissionId: string;
    final: Evaluation;
    /** 確定前に行った評価（途中経過） */
    earlier: Evaluation[];
    knowledge: KnowledgeMeta[];
    now: string;
  },
): { avoided: string[] } {
  const { submissionId, final, earlier, knowledge, now } = input;
  assertTime(now, "now");
  // 途中経過は同じ請求の評価だけ（round-3 X-15）
  if (earlier.some((e) => e.ctx.claimId !== final.ctx.claimId))
    throw new Error(`earlier に別の請求が混ざっている: ${final.ctx.claimId}`);
  const avoided: string[] = [];
  const finalKubun = new Set(final.ctx.lines.map((l) => l.kubun));
  db.transaction((tx) => {
    tx.update(submissions)
      .set({ superseded: true })
      .where(and(eq(submissions.claimId, final.ctx.claimId), ne(submissions.submissionId, submissionId)))
      .run();
    tx.insert(submissions)
      .values({
        submissionId,
        claimId: final.ctx.claimId,
        yearMonth: final.ctx.yearMonth,
        linesHash: hashLines(final.ctx.lines),
        submittedAt: now,
        superseded: false,
      })
      .run();
    for (const meta of knowledge.filter(isTarget)) {
      const state = matchState(meta, final.ctx, final.applied);
      // 不明なら記録しない（round-3 X-14）
      if (state === "unknown") continue;
      let role: "final" | "avoided" | "ignored" | null = null;
      let removed: string[] = [];
      if (state === "match") role = "final";
      else {
        const hitBefore = earlier.filter((e) => matches(meta, e.ctx, e.applied));
        if (hitBefore.length > 0) {
          if (meta.polarity === "avoid") role = "avoided";
          else {
            // kubunAll の区分のうち、途中にはあって確定版にはないもの（round-4 C-20・X-20）
            const kubunAll = meta.match.kubunAll ?? [];
            const before = new Set(hitBefore.flatMap((e) => e.ctx.lines.map((l) => l.kubun)));
            removed = kubunAll.filter((k) => before.has(k) && !finalKubun.has(k));
            if (removed.length > 0) role = "ignored";
          }
        }
      }
      if (!role) continue;
      if (role === "avoided") avoided.push(meta.id);
      tx.insert(applications)
        .values({ submissionId, knowledgeId: meta.id, rev: meta.rev, role, removedKubun: JSON.stringify(removed) })
        .run();
    }
  });
  return { avoided };
}

/** 結果の内容（kind・outcome・kubun[]）のハッシュ */
function contentHash(r: SubmissionResult): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: r.kind, outcome: r.outcome, kubun: [...r.kubun].sort() }))
    .digest("hex");
}

export type EffectiveResult = { resultId: string; kind: ResultKind; outcome: Outcome; kubun: string[]; importedAt: string };

/** その提出の「今有効な結果」：最後に採用した結果（資格を除く。C-13） */
export function effectiveResult(db: Db, submissionId: string): EffectiveResult | null {
  const row = db
    .select()
    .from(claimResults)
    .where(and(eq(claimResults.submissionId, submissionId), eq(claimResults.adopted, true), ne(claimResults.kind, "資格")))
    .orderBy(desc(claimResults.seq))
    .limit(1)
    .get();
  if (!row) return null;
  return { resultId: row.resultId, kind: row.kind, outcome: row.outcome, kubun: JSON.parse(row.kubun) as string[], importedAt: row.importedAt };
}

/**
 * 提出結果を取り込む。記録だけで、知識の状態は動かさない（v20：知識はレセメン会議まで更新しない）。
 * 受け取った ID はすべて残し、今有効な結果と内容が同じものは adopted=false にする（round-5 X-24）。
 */
export function importResult(db: Db, result: SubmissionResult, now: string): { duplicate: boolean; adopted: boolean } {
  assertTime(now, "now");
  const dup = db.select().from(claimResults).where(eq(claimResults.resultId, result.resultId)).get();
  if (dup) return { duplicate: true, adopted: false };
  const sub = db.select().from(submissions).where(eq(submissions.submissionId, result.submissionId)).get();
  if (!sub) throw new Error(`未知の submissionId: ${result.submissionId}`);

  const hash = contentHash(result);
  let adopted = result.kind !== "資格";
  if (adopted) {
    const current = effectiveResult(db, result.submissionId);
    if (current) {
      const curHash = contentHash({ ...result, kind: current.kind, outcome: current.outcome, kubun: current.kubun });
      if (curHash === hash) adopted = false;
    }
  }
  db.insert(claimResults)
    .values({
      resultId: result.resultId,
      submissionId: result.submissionId,
      kind: result.kind,
      outcome: result.outcome,
      kubun: JSON.stringify(result.kubun),
      contentHash: hash,
      adopted,
      importedAt: now,
    })
    .run();
  return { duplicate: false, adopted };
}
