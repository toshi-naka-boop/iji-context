// 行ったことの候補出しの数え方（design.md §15-12 L-163。段 18d）。eval/run-eval.ts と scripts/replay-acts.ts が同じ数え方を使う。
// 1 対 1：取り出した行為（with の子も 1 つずつ）は正解の 1 つにしか使わない。正解とその候補を結ぶ組み合わせの最大の数を「入った」とする。LLM は使わない
import { matchItem, rowsFor, type ItemMatch } from "../src/chart/match";
import { tableKeyOfAct, tableKeyOfChild, type ActCategory, type ChartAct, type ChildKind, type Tbl } from "../src/chart/acts";
import type { MastersDb } from "../src/masters/db";

/** 正解の 1 つ（合成カルテの match） */
export type Want = { tbl: Tbl; code: string };
/** 参考の割合から除く正解（評価のデータの印。理由を添える。L-163） */
export type RefExclude = { code: string; why: string };

/** 保存する取り出しの形（c＝種類、w＝書かれた名前、l＝lookup、with＝[子の種類, 書かれた名前, lookup]）。保存した AI の出力を LLM なしで再生するのに使う */
export type SavedAct = { c: ActCategory; w: string; l: string[]; with: [ChildKind, string, string[]][] };

export const saveActs = (acts: ChartAct[]): SavedAct[] => acts.map((a) => ({ c: a.category, w: a.written, l: a.lookup, with: (a.with ?? []).map((x): [ChildKind, string, string[]] => [x.kind, x.written, x.lookup]) }));

/** 取り出した行為と with の子を 1 つずつ、診療年月の 1 枚に当てる（前に選んだ対応は使わない） */
export function matchSaved(db: MastersDb, yearMonth: string, acts: SavedAct[]): ItemMatch[] {
  return acts.flatMap((a) => [
    matchItem(rowsFor(db, tableKeyOfAct(a.c), yearMonth), tableKeyOfAct(a.c), a.w, a.l, null),
    ...a.with.map(([kind, w, l]) => matchItem(rowsFor(db, tableKeyOfChild(kind), yearMonth), tableKeyOfChild(kind), w, l, null)),
  ]);
}

/** 合成カルテの記載の正解（行為と with の子を 1 つずつ） */
export const wantOf = (acts: ChartAct[]): Want[] => acts.flatMap((a) => [a.match!, ...(a.with ?? []).map((x) => x.match!)]).map((m) => ({ tbl: m.tbl, code: m.code }));

/** その取り出しの行為の初期値か、候補の上から limit 件に正解があるか */
const reaches = (g: ItemMatch, w: Want, limit: number): boolean =>
  (g.initial !== null && g.initial.tbl === w.tbl && g.initial.code === w.code) || g.candidates.slice(0, limit).some((c) => c.tbl === w.tbl && c.code === w.code);

/** 正解と取り出しの行為の最大の組み合わせ（増加道）。返すのは、正解ごとに組んだ取り出しの行為の番号（組めなければ -1） */
export function maxPairing(got: ItemMatch[], want: Want[], limit: number): number[] {
  const owner = new Array<number>(got.length).fill(-1);
  const tryWant = (wi: number, seen: boolean[]): boolean => {
    for (let gi = 0; gi < got.length; gi++) {
      if (seen[gi] || !reaches(got[gi], want[wi], limit)) continue;
      seen[gi] = true;
      if (owner[gi] < 0 || tryWant(owner[gi], seen)) {
        owner[gi] = wi;
        return true;
      }
    }
    return false;
  };
  want.forEach((_, wi) => tryWant(wi, new Array<boolean>(got.length).fill(false)));
  const pairOf = new Array<number>(want.length).fill(-1);
  owner.forEach((wi, gi) => {
    if (wi >= 0) pairOf[wi] = gi;
  });
  return pairOf;
}

/**
 * 1 つの記載の数。in20・top5 は 1 対 1 の組み合わせの数（74 行為の側）。ref・refIn20・refTop5 は除く正解を外した参考の数（L-163）。
 * 内訳：name＝組んだ行為の初期値（名前で当たった）が正解、lookup＝候補から選べる、unmatched＝組めない。hits＝20 件で組めた正解の番号
 */
export type ActsCount = { total: number; in20: number; top5: number; ref: number; refIn20: number; refTop5: number; name: number; lookup: number; unmatched: number; hits: number[] };

export function countActs(got: ItemMatch[], want: Want[], exclude: RefExclude[] = []): ActsCount {
  const p20 = maxPairing(got, want, 20);
  const p5 = maxPairing(got, want, 5);
  const hits = p20.flatMap((gi, wi) => (gi >= 0 ? [wi] : []));
  const name = hits.filter((wi) => got[p20[wi]].initial?.code === want[wi].code && got[p20[wi]].initial?.tbl === want[wi].tbl).length;
  const ex = new Set(exclude.map((e) => e.code));
  const refWant = want.filter((w) => !ex.has(w.code));
  const n = (p: number[]) => p.filter((gi) => gi >= 0).length;
  return {
    total: want.length,
    in20: hits.length,
    top5: n(p5),
    ref: refWant.length,
    refIn20: n(maxPairing(got, refWant, 20)),
    refTop5: n(maxPairing(got, refWant, 5)),
    name,
    lookup: hits.length - name,
    unmatched: want.length - hits.length,
    hits,
  };
}
