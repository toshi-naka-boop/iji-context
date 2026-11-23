// 公的文書とローカルルールの突き合わせ（design.md §4-6。FR-128〜131）
// 決まった規則だけで決める。LLM は使わない。同じ入力なら同じ結果になり、文書の並び順に依らない
import { createHash } from "node:crypto";
import { LAYER_TRIGGERS } from "../lifecycle/layers";
import { jstYearMonth } from "../lifecycle/time";
import type { KnowledgeMeta, OfficialCheck } from "../lifecycle/types";
import type { OfficialDoc, OfficialInput, Verdict } from "./types";

/** 文書 1 件と知識 1 件の結果。「対象外」はその知識の話ではない文書（表示にも数えない） */
export type DocVerdict = Exclude<Verdict, "公的根拠なし"> | "対象外";

/** 知識の区分集合：kubunAll（空でないとき）、なければ ruleId のルールの区分、どちらもなければ空 */
function kubunOf(meta: KnowledgeMeta, ruleKubun?: (ruleId: string) => string[]): string[] {
  const m = meta.match;
  if (m.kubunAll && m.kubunAll.length > 0) return m.kubunAll;
  if (m.ruleId !== undefined && ruleKubun) return ruleKubun(m.ruleId);
  return [];
}

/** 規則 4：条件が両立しないか（同じ事実で値が違う、同じ区分の摘要コメントの有無が違う）。下限の条件は常に両立 */
function incompatible(meta: KnowledgeMeta, doc: OfficialDoc): boolean {
  const a = meta.match.facts ?? {};
  const b = doc.scope.facts ?? {};
  for (const key of ["table8_2", "table7", "insurance"] as const) {
    if (a[key] !== undefined && b[key] !== undefined && a[key] !== b[key]) return true;
  }
  for (const x of meta.match.commentOn ?? []) {
    if ((doc.scope.commentOn ?? []).some((y) => y.kubun === x.kubun && y.present !== x.present)) return true;
  }
  return false;
}

/** 規則 1〜4 を通るか（その知識の話をしている文書か）。通らない文書は対象外 */
export function related(meta: KnowledgeMeta, doc: OfficialDoc, generation: string, ruleKubun?: (ruleId: string) => string[]): boolean {
  // 1：その改定に適用しない文書（FR-131）
  if (!doc.generations.includes(generation)) return false;
  // 2：区分が交わらない
  const kubun = kubunOf(meta, ruleKubun);
  if (!kubun.some((k) => doc.scope.kubun.includes(k))) return false;
  // 3：審査支払機関・都道府県が、両方決まっていて違う（片方が未設定なら「問わない」）
  const { payer, prefecture } = meta.match;
  if (payer !== undefined && doc.scope.payer !== null && payer !== doc.scope.payer) return false;
  if (prefecture !== undefined && doc.scope.prefecture !== null && prefecture !== doc.scope.prefecture) return false;
  // 4：別の状況の話
  return !incompatible(meta, doc);
}

/** 条件に当たるかを人が確かめられる文書か：向き（認める・認めない）があり、語彙で表せない条件を持つ（§11-3） */
export const checkable = (doc: OfficialDoc): boolean => doc.stance !== "条件つき" && doc.scope.conditionNote !== null;

/** 文書 1 件と知識 1 件の判定。§4-6 の表（規則 5 は §11-3 の 5a〜5d）を上から順に見て、最初に当てはまったものを返す */
export function judge(meta: KnowledgeMeta, doc: OfficialDoc, generation: string, ruleKubun?: (ruleId: string) => string[]): DocVerdict {
  if (!related(meta, doc, generation, ruleKubun)) return "対象外";
  // 5a：向きのない文書。整合とも矛盾とも言わない
  if (doc.stance === "条件つき") return "関連あり・未照合";
  // 5b〜5d：文書の側に、語彙で表せない条件がある。機械は条件を読まない（知識の側の近似・注記も見ない）。先へ進めるのは人の確認だけ
  if (doc.scope.conditionNote !== null) {
    const check = meta.official_checks?.[docKey(doc)];
    if (!check) return "関連あり・未照合";
    if (!check.applies) return "対象外";
  }
  // 6・7：向きが同じなら整合、逆なら矛盾の恐れ
  return (doc.stance === "認める") === (meta.polarity === "allow") ? "整合" : "矛盾の恐れ";
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export type JudgeAll = {
  /** 危ない側を優先した 1 つの結果（矛盾の恐れ → 関連あり・未照合 → 整合。1 件も当たらなければ公的根拠なし） */
  verdict: Verdict;
  /** 知識が近似（matchApprox）か。真なら、欄と議題で「条件の注記あり」と知識の conditionNote を添える */
  approx: boolean;
  /** 結果ごとの文書 id（id 昇順。出典リンク用） */
  ids: Record<Exclude<DocVerdict, "対象外">, string[]>;
  /** 人が条件を確かめた文書（id 昇順）と、確かめた人・日。当たらないと確かめた文書（ids には入らない）も含む。確認が 1 件もなければ欄ごと持たない */
  checked?: ({ id: string } & OfficialCheck)[];
};

/** 知識 1 件についてのまとめ */
export function judgeAll(meta: KnowledgeMeta, docs: OfficialDoc[], generation: string, ruleKubun?: (ruleId: string) => string[]): JudgeAll {
  const ids: JudgeAll["ids"] = { 矛盾の恐れ: [], "関連あり・未照合": [], 整合: [] };
  const checked: NonNullable<JudgeAll["checked"]> = [];
  for (const doc of [...docs].sort(byId)) {
    const v = judge(meta, doc, generation, ruleKubun);
    if (v !== "対象外") ids[v].push(doc.id);
    const check = checkable(doc) && related(meta, doc, generation, ruleKubun) ? meta.official_checks?.[docKey(doc)] : undefined;
    if (check) checked.push({ id: doc.id, ...check });
  }
  const verdict: Verdict =
    ids["矛盾の恐れ"].length > 0 ? "矛盾の恐れ" : ids["関連あり・未照合"].length > 0 ? "関連あり・未照合" : ids["整合"].length > 0 ? "整合" : "公的根拠なし";
  return { verdict, approx: meta.matchApprox, ids, ...(checked.length > 0 ? { checked } : {}) };
}

/**
 * 文書の鍵 `<id>#<h>`。h は判定に効く欄（scope・stance・generations）の内容ハッシュの先頭 8 桁。
 * 要旨・URL・確認日だけの直しでは変わらない。判定に効く欄を直した文書は、未確認の別の文書として扱う（§4-3）
 */
export function docKey(doc: OfficialDoc): string {
  const s = doc.scope;
  const f = s.facts ?? {};
  const content = JSON.stringify([
    [...s.kubun].sort(),
    s.payer,
    s.prefecture,
    [f.careLevelMin ?? null, f.insurance ?? null, f.table8_2 ?? null, f.table7 ?? null],
    (s.commentOn ?? []).map((c) => [c.kubun, c.present]).sort(),
    s.consecutiveMonths ? [s.consecutiveMonths.kubun, s.consecutiveMonths.min] : null,
    s.conditionNote,
    doc.stance,
    [...doc.generations].sort(),
  ]);
  return `${doc.id}#${createHash("sha256").update(content).digest("hex").slice(0, 8)}`;
}

/** now の年月（日本時間）の版で、その知識と「矛盾の恐れ」になる文書（id 昇順）。④ が効かない層・版のない年月は空 */
export function conflictDocs(meta: KnowledgeMeta, official: OfficialInput, now: string): OfficialDoc[] {
  if (!LAYER_TRIGGERS[meta.layer].official) return [];
  const yearMonth = jstYearMonth(now);
  const generation = official.generationOf(yearMonth);
  if (generation === null) return [];
  const ruleKubun = official.ruleKubun ? (ruleId: string) => official.ruleKubun!(ruleId, yearMonth) : undefined;
  return [...official.docs].sort(byId).filter((d) => judge(meta, d, generation, ruleKubun) === "矛盾の恐れ");
}

/** 上の文書の鍵の集合（昇順）。トリガー④と、議題の snapshot が使う。文書がいつ入ったかは見ない */
export function conflictKeys(meta: KnowledgeMeta, official: OfficialInput, now: string): string[] {
  return conflictDocs(meta, official, now).map(docKey).sort();
}
