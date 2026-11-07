// F7 処理体験（1 件＝1 問）と F10 レベル。spec FR-16〜18・FR-28・FR-29、決定32〜36
// 流れは「メンターのヒント → 本人が確定 → ルールエンジンの判定 → メンターの解説」。順番は飛ばせない
// 判定は evaluate（決定的）だけで行い、メンター（LLM）は判定を上書きしない（FR-11）
import { evaluate } from "../engine";
import type { ClaimContext, ClaimLine, EngineResult, Finding } from "../engine/types";
import { assertTime } from "../lifecycle/time";

export type Phase = "ヒント" | "判定" | "解説" | "完了";
/** 通常＝区分を自分で選ぶ。選択＝急いでいるとき、区分を選択肢から選ぶ（src/practice/choice.ts） */
export type Mode = "通常" | "選択";

export type Question = {
  id: string;
  clerkId: string;
  claimId: string;
  phase: Phase;
  startedAt: string;
  /** ヒントの段階でエンジンにかけた下書き（F9 の「提出前に指摘した」の記録） */
  drafts: { lines: ClaimLine[]; findings: Finding[]; at: string }[];
  /** 本人が確定した算定行と、その判定 */
  confirmed: { lines: ClaimLine[]; result: EngineResult; at: string } | null;
  /** 正解：確定した請求に、情報不足以外の指摘がない（情報不足は本人の誤りではない。仮の定義） */
  correct: boolean | null;
  finishedAt: string | null;
  /** 選択モードか（ない古い記録は通常） */
  mode?: Mode;
  /** 選択モードで本人が選んだもの（正誤はユスティ） */
  picks?: { lineIndex: number; option: string; correct: boolean; at: string }[];
  /** 訪問の時点（レセコンに入れる前）の問題なら、その訪問日（FR-68）。ないものは月末の UKE から */
  asOf?: string;
};

/** 判定のしかた（訪問の時点では、月末まで決まらないルールを外す） */
export type Judge = (ctx: ClaimContext) => EngineResult;

export function startQuestion(id: string, clerkId: string, claimId: string, now: string, mode: Mode = "通常", asOf?: string): Question {
  assertTime(now, "now");
  return { id, clerkId, claimId, phase: "ヒント", startedAt: now, drafts: [], confirmed: null, correct: null, finishedAt: null, mode, picks: [], ...(asOf ? { asOf } : {}) };
}

/** ヒントの段階で下書きをエンジンにかける（何度でもよい）。メンターはこの指摘を手がかりにヒントを出す */
export function checkDraft(q: Question, ctx: ClaimContext, now: string, judge: Judge = evaluate): { question: Question; result: EngineResult } {
  assertTime(now, "now");
  if (q.phase !== "ヒント") throw new Error(`下書きを確かめられない段階: ${q.phase}`);
  if (ctx.claimId !== q.claimId) throw new Error(`別の請求: ${ctx.claimId}`);
  const result = judge(ctx);
  return { question: { ...q, drafts: [...q.drafts, { lines: ctx.lines, findings: result.findings, at: now }] }, result };
}

export const isCorrect = (r: EngineResult): boolean => r.findings.every((f) => f.kind === "情報不足");

/** 本人が確定する。ここでエンジンが判定する */
export function confirm(q: Question, ctx: ClaimContext, now: string, judge: Judge = evaluate): Question {
  assertTime(now, "now");
  if (q.phase !== "ヒント") throw new Error(`確定できない段階: ${q.phase}`);
  if (ctx.claimId !== q.claimId) throw new Error(`別の請求: ${ctx.claimId}`);
  const result = judge(ctx);
  return { ...q, phase: "判定", confirmed: { lines: ctx.lines, result, at: now }, correct: isCorrect(result) };
}

/** 判定を見せた後、メンターの解説へ */
export function toExplanation(q: Question): Question {
  if (q.phase !== "判定") throw new Error(`解説に進めない段階: ${q.phase}`);
  return { ...q, phase: "解説" };
}

export function finish(q: Question, now: string): Question {
  assertTime(now, "now");
  if (q.phase !== "解説") throw new Error(`終えられない段階: ${q.phase}`);
  return { ...q, phase: "完了", finishedAt: now };
}

/**
 * スコアは件数と連続正解だけ（金額・ランキング・ノルマにしない。FR-29）
 * credit はレベルに使う件数。選択モードの 1 件は選択肢に答えが見えている分、choiceWeight 件と数える
 */
export function score(questions: Question[], clerkId: string, choiceWeight = 1): { count: number; credit: number; streak: number; bestStreak: number } {
  const done = questions
    .filter((q) => q.clerkId === clerkId && q.phase === "完了" && q.finishedAt !== null)
    .sort((a, b) => (a.finishedAt! < b.finishedAt! ? -1 : a.finishedAt! > b.finishedAt! ? 1 : a.id < b.id ? -1 : 1));
  let streak = 0;
  let best = 0;
  let credit = 0;
  for (const q of done) {
    credit += q.mode === "選択" ? choiceWeight : 1;
    streak = q.correct ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  return { count: done.length, credit, streak, bestStreak: best };
}

/** 処理件数の累計から Lv.1〜10（しきい値は config/levels.json）。選択モードを小さく数えるので小数も受ける */
export function levelOf(count: number, thresholds: number[]): number {
  if (thresholds.length !== 10 || thresholds[0] !== 0 || thresholds.some((t, i) => i > 0 && t <= thresholds[i - 1]))
    throw new Error("しきい値は 0 から始まる増加列で 10 個");
  if (!Number.isFinite(count) || count < 0) throw new Error(`件数が不正: ${count}`);
  let lv = 1;
  thresholds.forEach((t, i) => {
    if (count >= t) lv = i + 1;
  });
  return lv;
}

/** 本人向けの表示。自分のレベルだけを返し、他人のレベルは返さない（FR-16） */
export function myStatus(questions: Question[], clerkId: string, thresholds: number[], choiceWeight = 1): { level: number; count: number; streak: number } {
  const s = score(questions, clerkId, choiceWeight);
  return { level: levelOf(s.credit, thresholds), count: s.count, streak: s.streak };
}
