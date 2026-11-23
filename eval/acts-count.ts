// 行ったことの候補出しの数え方（design.md §15-12 L-163。段 18d）。eval/run-eval.ts と scripts/replay-acts.ts が同じ数え方を使う。
// 1 対 1：取り出した行為（with の子も 1 つずつ）は正解の 1 つにしか使わない。正解とその候補を結ぶ組み合わせの最大の数を「入った」とする。LLM は使わない
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchItem, rowsFor, type ItemMatch } from "../src/chart/match";
import { tableKeyOfAct, tableKeyOfChild, type ActCategory, type ChartAct, type ChildKind, type Tbl } from "../src/chart/acts";
import type { MastersDb } from "../src/masters/db";

/** 正解の 1 つ（合成カルテの match）。id は中身で振った正解の ID（design.md §16-9。round-64 C-404） */
export type Want = { tbl: Tbl; code: string; id?: string };
/**
 * 合否の数から除く正解（規則・患者の情報で出すもの。design.md §16-9。eval/datasets/acts-exclude.json）。id で指す（中身で振った ID）。
 * code で指す形は v32 の参考の印（L-163）の書き方で、id がなければ同じコードの正解を全部除く
 */
export type RefExclude = { id?: string; code?: string; why: string };

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

/**
 * 合成カルテの記載の正解（行為と with の子を 1 つずつ）。at（症例・日付）を渡すと、正解の ID を中身で振る（design.md §16-9）：
 * 行為は `<症例>/<日付>/<tbl>:<code>#<n>`（n はその日の同じ tbl:code の正解の並びでの順番。1 から）、with の子は `<親の ID>/<tbl>:<code>#<n>`（n は親の中の順番）。
 * 行為を途中に入れても、ほかの tbl:code の ID は変わらない
 */
export const wantOf = (acts: ChartAct[], at?: { chart: string; date: string }): Want[] => {
  const seen = new Map<string, number>();
  const nth = (scope: string, key: string) => {
    const k = `${scope}|${key}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n;
  };
  return acts.flatMap((a) => {
    const m = a.match!;
    const key = `${m.tbl}:${m.code}`;
    const id = at ? `${at.chart}/${at.date}/${key}#${nth("", key)}` : undefined;
    return [
      { tbl: m.tbl, code: m.code, ...(id ? { id } : {}) },
      ...(a.with ?? []).map((x) => {
        const ck = `${x.match!.tbl}:${x.match!.code}`;
        return { tbl: x.match!.tbl, code: x.match!.code, ...(id ? { id: `${id}/${ck}#${nth(id, ck)}` } : {}) };
      }),
    ];
  });
};

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
 * 1 つの記載の数。in20・top5 は 1 対 1 の組み合わせの数（除く正解を含む全部の正解の側）。ref・refIn20・refTop5 は除く正解を外した数（文章から取り出すべき行為。design.md §16-9 の合否の数）。
 * 内訳：name＝組んだ行為の初期値（名前で当たった）が正解、lookup＝候補から選べる、unmatched＝組めない。hits＝20 件で組めた正解の番号。
 * extra＝余計な取り出し（20 件の 1 対 1 の組み合わせで、除く正解を含むどの正解にも組めなかった取り出し。行為と with の子を 1 つずつ。L-192）、
 * ruleTaken＝除く正解（規則で出すもの）に組んだ取り出しの数（余計な取り出しとは別に数える）
 */
export type ActsCount = { total: number; in20: number; top5: number; ref: number; refIn20: number; refTop5: number; name: number; lookup: number; unmatched: number; hits: number[]; extra: number; ruleTaken: number };

/** 除く正解に当たるか（id があれば id、なければ同じコード） */
const excluded = (w: Want, exclude: RefExclude[]) => exclude.some((e) => (e.id !== undefined ? e.id === w.id : e.code === w.code));

export function countActs(got: ItemMatch[], want: Want[], exclude: RefExclude[] = []): ActsCount {
  const p20 = maxPairing(got, want, 20);
  const p5 = maxPairing(got, want, 5);
  const hits = p20.flatMap((gi, wi) => (gi >= 0 ? [wi] : []));
  const name = hits.filter((wi) => got[p20[wi]].initial?.code === want[wi].code && got[p20[wi]].initial?.tbl === want[wi].tbl).length;
  const refWant = want.filter((w) => !excluded(w, exclude));
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
    extra: got.length - hits.length,
    ruleTaken: hits.filter((wi) => excluded(want[wi], exclude)).length,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 合否の組の束（design.md §16-9。L-210・C-404・C-414）

/** 除く正解（eval/datasets/acts-exclude.json） */
export const loadExclude = (root: string): RefExclude[] => JSON.parse(readFileSync(path.join(root, "eval", "datasets", "acts-exclude.json"), "utf8")) as RefExclude[];

/** 決まった形の JSON（キーの順を並べ、空白を入れない） */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

type DatasetRow = { id: string; kind: string; split?: string; chart?: string; date?: string };

/**
 * 固定する束の指紋（sha256）：acts-exclude.json、resemen.jsonl の split が gate の行（id の順）、その行が指すカルテ（fixtures/charts/<chart>-abbrev.json）のその日の entry の全体、
 * の 3 つを決まった形の JSON にして連結したもの。どれを動かしても指紋が変わる
 */
export function gateBundleSha(root: string): string {
  const exclude = JSON.parse(readFileSync(path.join(root, "eval", "datasets", "acts-exclude.json"), "utf8")) as unknown;
  const rows = readFileSync(path.join(root, "eval", "datasets", "resemen.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DatasetRow)
    .filter((r) => r.kind === "acts" && r.split === "gate")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const entries = rows.map((r) => {
    const chart = JSON.parse(readFileSync(path.join(root, "fixtures", "charts", `${r.chart}-abbrev.json`), "utf8")) as { entries: { date: string }[] };
    const e = chart.entries.find((x) => x.date === r.date);
    if (!e) throw new Error(`合否の組の記載 ${r.id} の entry がない`);
    return e;
  });
  return createHash("sha256").update(canonical(exclude)).update(canonical(rows)).update(canonical(entries)).digest("hex");
}

/**
 * 合否の組の束の指紋の定数（E-14 の記載を足して、最初の実際の AI の評価の前に固定した。L-210）。
 * 読んだ束の指紋がこの値と違えば、評価は失敗する（除く正解・正解の中身・合否の組の記載・その記載の文章のどれを動かしても、合格の線に掛からない）。直すときは設計の版を上げる
 */
export const GATE_SHA256 = "20713e60e0e2247a4e3d6c8faef4c48f936a5f11c38fc652e6013516ccda642b";

/** 束の指紋が定数と合うことを確かめる。違えば例外（評価を失敗させる） */
export function assertGate(root: string, expected: string = GATE_SHA256): string {
  const sha = gateBundleSha(root);
  if (sha !== expected) throw new Error(`合否の組の束の指紋が固定した値と違います（読んだ ${sha.slice(0, 12)}…・固定 ${expected.slice(0, 12)}…）。除く正解・合否の組の記載・カルテを動かしたなら、設計の版を上げてから固定し直してください`);
  return sha;
}
