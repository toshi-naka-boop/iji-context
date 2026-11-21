// 同梱の版の一覧と、診療年月から版を 1 つに決める規則（design.md §2-5）
// 該当する版がなければ例外にし、近い版で代用しない
import { YEAR_MONTH } from "../../demo/period";
import { assertCodes } from "./codes";
import { r2024 } from "./r2024";
import { r2026 } from "./r2026";
import { r2027_06 } from "./r2027-06";
import type { Revision } from "./types";

/** "YYYY-MM" の翌月 */
function nextMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const covers = (rev: Revision, yearMonth: string) => rev.effectiveFrom <= yearMonth && yearMonth <= rev.effectiveUntil;

/** 版 1 つの形の検査（id の重複・期間の形）。請求の判定に使う版と、比較用の版の両方に掛ける */
function assertShape(r: Revision, ids: Set<string>): void {
  if (ids.has(r.id)) throw new Error(`版の id が重複: ${r.id}`);
  ids.add(r.id);
  if (!YEAR_MONTH.test(r.effectiveFrom) || !YEAR_MONTH.test(r.effectiveUntil)) throw new Error(`版の期間は YYYY-MM: ${r.id}`);
  if (r.effectiveFrom > r.effectiveUntil) throw new Error(`版の開始月が終了月より後: ${r.id}`);
}

/** 版の一覧の検査。id の重複・期間の重なり・隣り合う版のあいだの空白・点数表にない区分を持つルール・コードの表の不備（codes.ts の assertCodes）などを拒否する */
export function assertRevisions(revs: Revision[]): void {
  const ids = new Set<string>();
  for (const r of revs) {
    assertShape(r, ids);
    for (const rule of r.rules) {
      const bad = rule.kubun.find((k) => !Object.hasOwn(r.points, k));
      if (bad) throw new Error(`ルール ${rule.id} の区分が版 ${r.id} の点数表にない: ${bad}`);
    }
    assertCodes(r);
  }
  const sorted = [...revs].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.effectiveFrom <= prev.effectiveUntil) throw new Error(`版の期間が重なる: ${prev.id} と ${cur.id}`);
    if (cur.effectiveFrom !== nextMonth(prev.effectiveUntil)) throw new Error(`版のあいだに空白がある: ${prev.id} と ${cur.id}`);
  }
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.kind !== "値の変更") continue;
    const prev = sorted[i - 1];
    if (!prev || prev.generation !== cur.generation) throw new Error(`値の変更の版に、同じ改定の直前の版がない: ${cur.id}`);
    const a = Object.keys(prev.points).sort().join("\0");
    const b = Object.keys(cur.points).sort().join("\0");
    if (a !== b) throw new Error(`値の変更の版の区分の集合が直前の版と違う: ${cur.id}`);
  }
}

/** 同梱の版の一覧。令和8年度改定後の版と、その値の変更の版（FR-92・FR-147） */
export const REVISIONS: Revision[] = [r2026, r2027_06];
assertRevisions(REVISIONS);

/**
 * 比較用の版の検査（design.md §11-2）。確かめるのは id（請求の判定に使う版とも重ならない）・期間の形・点数表だけ。
 * コードの表の網羅（assertCodes）と期間の続き方は、請求の判定に使う版にだけ掛ける
 */
export function assertCompareRevisions(compare: Revision[], revs: Revision[]): void {
  const ids = new Set(revs.map((r) => r.id));
  for (const r of compare) {
    assertShape(r, ids);
    const defs = Object.entries(r.points);
    if (defs.length === 0) throw new Error(`比較用の版の点数表が空: ${r.id}`);
    for (const [kubun, d] of defs) {
      const ok = d.name !== "" && (d.points === null ? d.source === "未収載" : Number.isInteger(d.points) && d.points >= 0);
      if (!ok) throw new Error(`比較用の版 ${r.id} の点数表の行が違う: ${kubun}`);
    }
  }
}

/**
 * 改定の比較と試算の表示にだけ使う版（design.md §11-2・§11-12）。請求の判定には使わない：
 * 診療年月から版を決める規則（resolveRevision）はこの一覧を見ないので、この版の期間の診療年月には今も版がない
 */
export const COMPARE_REVISIONS: Revision[] = [r2024];
assertCompareRevisions(COMPARE_REVISIONS, REVISIONS);

/** 比較と試算で選べる版（古い順）。id から版を引く。ない id は undefined */
export const SELECTABLE_REVISIONS: Revision[] = [...COMPARE_REVISIONS, ...REVISIONS];
export const revisionById = (id: string): Revision | undefined => SELECTABLE_REVISIONS.find((r) => r.id === id);
/**
 * 取り込んだ UKE の試算で選べる版（古い順。design.md §11-12）：診療行為コードの表を持つ版だけ。
 * コードの表が空の版（比較用の版）で読むと全部の行が対象外になり、空の結果が「問題なし」に見えるので、選ばせない
 */
export const UKE_TRIAL_REVISIONS: Revision[] = SELECTABLE_REVISIONS.filter((r) => Object.keys(r.codes).length > 0);

/**
 * 画面の選択肢にする版の一覧（id・名前・その診療年月の請求の判定に使う版か）。作るのはここ 1 か所（比較・取り込んだレセプトの試算・カルテの算定プレビュー）。
 * own が真になるのは、請求の判定に使う版（REVISIONS）のうち、その診療年月に当たる 1 つだけ。診療年月を渡さなければ、どれも偽
 */
export const revisionChoices = (revs: Revision[], yearMonth?: string): { id: string; label: string; own: boolean }[] =>
  revs.map((r) => ({ id: r.id, label: r.label, own: yearMonth !== undefined && REVISIONS.includes(r) && covers(r, yearMonth) }));

/** 区分が、同梱のどれかの版の点数表にあるか（知識・公的文書の区分のキーの検査に使う。design.md §3） */
export const isKnownKubun = (kubun: string): boolean => REVISIONS.some((r) => Object.hasOwn(r.points, kubun));

/** 診療年月に当たる版があるか（形式違いの年月は「ない」） */
export function hasRevision(yearMonth: string, revs: Revision[] = REVISIONS): boolean {
  return YEAR_MONTH.test(yearMonth) && revs.some((r) => covers(r, yearMonth));
}

/** 診療年月から版を 1 つに決める。形式違い・該当なしは例外（近い版で代用しない） */
export function resolveRevision(yearMonth: string, revs: Revision[] = REVISIONS): Revision {
  if (!YEAR_MONTH.test(yearMonth)) throw new Error(`診療年月の形式が違う（YYYY-MM）: ${yearMonth}`);
  const hit = revs.filter((r) => covers(r, yearMonth));
  if (hit.length === 0) throw new Error(`診療年月に当たる版がない: ${yearMonth}`);
  if (hit.length > 1) throw new Error(`診療年月に当たる版が複数ある: ${yearMonth}（${hit.map((r) => r.id).join(", ")}）`);
  return hit[0];
}

/** その版の区分の点数。その版にない区分は例外（黙って 0 点にしない） */
export function pointsOf(rev: Revision, kubun: string): number | null {
  const def = Object.hasOwn(rev.points, kubun) ? rev.points[kubun] : undefined;
  if (!def) throw new Error(`未知の区分: ${kubun}`);
  return def.points;
}
