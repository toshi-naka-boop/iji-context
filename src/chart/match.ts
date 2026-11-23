// カルテの「行ったこと」を基本マスターに当てる（design.md §15-7。FR-193）。決まった規則だけで行い、LLM は使わない。
// 規則は 2 つ：(1) 名称の完全一致（normName を両側に掛ける）が 1 つ (2) 決まらないときは本人が候補から選ぶ。候補は診療年月の 1 枚に実在する行だけ
import { statSync } from "node:fs";
import { hasRevision, resolveRevision } from "../engine/revisions";
import { pickSnapshot, type MastersDb } from "../masters/db";
import { normName } from "../notice/notice";
import type { ActMatch, TableKey, Tbl } from "./acts";

/** 候補の 1 行。prior＝前に選んだもの */
export type Candidate = { tbl: Tbl; code: string; name: string; prior: boolean };
/** 1 つの行為（または with の子）の当て方：initial＝選んだ状態で出す初期値（当てた・前に選んだもの）。ないときは本人が候補から選ぶ */
export type ItemMatch = { initial: ActMatch | null; candidates: Candidate[] };
/** 前に選んだ対応（クリニックごと。chart_act_aliases の行） */
export type Alias = { tbl: Tbl; code: string };

type Row = { tbl: Tbl; code: string; name: string; norm: string };

/** 候補の上限（設計の値） */
export const MAX_CANDIDATES = 20;

const memo = new WeakMap<MastersDb, Map<string, Row[]>>();
const fileMemo = new Map<string, Row[]>();

/** その表の 1 枚の行（名称を normName にしたもの）。同じファイル・同じ 1 枚なら読み直さない */
function tableRows(db: MastersDb, tbl: Tbl, snapshot: string): Row[] {
  const read = () =>
    (db.prepare(`SELECT code, name FROM ${tbl} WHERE snapshot = ?`).all(snapshot) as { code: string; name: string }[]).map((r) => ({ tbl, code: r.code, name: r.name, norm: normName(r.name) }));
  if (db.memory) {
    const m = memo.get(db) ?? new Map<string, Row[]>();
    memo.set(db, m);
    const k = `${tbl}|${snapshot}`;
    if (!m.has(k)) m.set(k, read());
    return m.get(k)!;
  }
  // 作り直した masters.db（更新時刻が変わった）の古い行は捨てる
  const file = `${db.name}|${statSync(db.name).mtimeMs}|`;
  const k = `${file}${tbl}|${snapshot}`;
  if (!fileMemo.has(k)) {
    for (const old of [...fileMemo.keys()]) if (old.startsWith(`${db.name}|`) && !old.startsWith(file)) fileMemo.delete(old);
    fileMemo.set(k, read());
  }
  return fileMemo.get(k)!;
}

/** 第5部 投薬（区分番号 F）の行のコード（医科診療行為の 1 枚の中で） */
function toyakuCodes(db: MastersDb, snapshot: string): Set<string> {
  return new Set((db.prepare("SELECT code FROM shinryo WHERE snapshot = ? AND alpha = 'F'").all(snapshot) as { code: string }[]).map((r) => r.code));
}

/**
 * 診療年月の 1 枚の、引く表の行（category で決めた表だけ）。toyaku は医薬品と、医科診療行為の第5部 投薬。
 * 要る表の 1 枚が 1 つもない・版のない診療年月なら null（マスターがない）
 */
export function rowsFor(db: MastersDb | null, key: TableKey, yearMonth: string): Row[] | null {
  if (!db || !hasRevision(yearMonth)) return null;
  const generation = resolveRevision(yearMonth).generation;
  const tbls: Tbl[] = key === "toyaku" ? ["iyakuhin", "shinryo"] : [key];
  const out: Row[] = [];
  let any = false;
  for (const tbl of tbls) {
    const snap = pickSnapshot(db, tbl, yearMonth, generation);
    if (!snap) continue;
    any = true;
    const rows = tableRows(db, tbl, snap.snapshot);
    if (key === "toyaku" && tbl === "shinryo") {
      const f = toyakuCodes(db, snap.snapshot);
      out.push(...rows.filter((r) => f.has(r.code)));
    } else out.push(...rows);
  }
  return any ? out : null;
}

const shortest = (rows: Row[]) => [...rows].sort((a, b) => a.name.length - b.name.length || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
const byCode = (a: Row, b: Row) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.tbl < b.tbl ? -1 : a.tbl > b.tbl ? 1 : 0);

/** 名称がその語で始まる行（完全一致を除く）を先、名称の途中にその語がある行を後にし、同じ強さの中はコードの順（L-161） */
function prefixThenPartial(rows: Row[], t: string): Row[] {
  const prefix = rows.filter((r) => r.norm !== t && r.norm.startsWith(t)).sort(byCode);
  const partial = rows.filter((r) => !r.norm.startsWith(t) && r.norm.includes(t)).sort(byCode);
  return [...prefix, ...partial];
}

/**
 * 1 つの行為を当てる（決まった規則）。
 * 初期値：前に選んだ対応が今の 1 枚の引く表にあればそれ（名前の完全一致が別のコードにあっても。L-95）。なければ名称の完全一致がちょうど 1 つのときだけ当てる。
 * 投薬は医薬品の完全一致を先に見て、医薬品で 0 のときだけ第5部の完全一致を見る（C-224）。
 * 候補の並べ方（上から順に、同じコードは 1 回、20 件まで）：前に選んだもの → 書かれた名前の完全一致 → lookup の語の完全一致（語の順）→
 * lookup の語と書かれた名前の前方一致・部分一致（v32。L-161）：語の順の lookup の語の最後に書かれた名前を置いた「語の輪」を作り（normName で同じになる語は先に出た 1 回だけ）、
 * 語ごとに前方一致を先・部分一致を後、同じ強さの中はコードの順にする。輪を 1 周するごとに各語から 1 件ずつ（すでに候補に入った行は語の番を使わずに飛ばし、当たりの尽きた語も飛ばす）。
 * lookup の語で自動には当てない
 */
export function matchItem(rows: Row[] | null, key: TableKey, written: string, lookup: string[], alias: Alias | null): ItemMatch {
  if (!rows) return { initial: null, candidates: [] };
  const w = normName(written);
  const aliasRow = alias ? (rows.find((r) => r.tbl === alias.tbl && r.code === alias.code) ?? null) : null;
  const exact = rows.filter((r) => r.norm === w);
  let initial: ActMatch | null = null;
  const as = (r: Row, by: ActMatch["by"]): ActMatch => ({ tbl: r.tbl, code: r.code, name: r.name, by });
  if (aliasRow) initial = as(aliasRow, "alias");
  else if (key === "toyaku") {
    const drug = exact.filter((r) => r.tbl === "iyakuhin");
    const proc = exact.filter((r) => r.tbl === "shinryo");
    if (drug.length === 1) initial = as(drug[0], "name");
    else if (drug.length === 0 && proc.length === 1) initial = as(proc[0], "name");
  } else if (exact.length === 1) initial = as(exact[0], "name");

  const out: Candidate[] = [];
  const has = (r: Row) => out.some((c) => c.tbl === r.tbl && c.code === r.code);
  const add = (r: Row, prior = false) => {
    if (out.length >= MAX_CANDIDATES || has(r)) return;
    out.push({ tbl: r.tbl, code: r.code, name: r.name, prior });
  };
  if (aliasRow) add(aliasRow, true);
  for (const r of shortest(exact)) add(r);
  const terms = lookup.map(normName).filter(Boolean);
  for (const t of terms) for (const r of shortest(rows.filter((x) => x.norm === t))) add(r);
  // 語の輪（L-161。round-63 C-392）
  const ring = [...new Set([...terms, ...(w ? [w] : [])])].map((t) => prefixThenPartial(rows, t));
  const pos = ring.map(() => 0);
  for (let moved = true; moved && out.length < MAX_CANDIDATES; ) {
    moved = false;
    for (let k = 0; k < ring.length && out.length < MAX_CANDIDATES; k++) {
      while (pos[k] < ring[k].length && has(ring[k][pos[k]])) pos[k]++;
      if (pos[k] < ring[k].length) {
        add(ring[k][pos[k]++]);
        moved = true;
      }
    }
  }
  return { initial, candidates: out };
}

/** マスターを名前で探す（名称の部分一致を 20 件まで。前方一致を先・部分一致を後、同じ強さの中はコードの順。v32。L-161） */
export function searchRows(rows: Row[] | null, q: string): Candidate[] {
  const t = normName(q);
  if (!rows || !t) return [];
  const prefix = rows.filter((r) => r.norm.startsWith(t)).sort(byCode);
  const partial = rows.filter((r) => !r.norm.startsWith(t) && r.norm.includes(t)).sort(byCode);
  return [...prefix, ...partial]
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({ tbl: r.tbl, code: r.code, name: r.name, prior: false }));
}

/** その表のそのコードの行（今の 1 枚の、引く表にあるときだけ） */
export const rowIn = (rows: Row[] | null, tbl: Tbl, code: string): Row | null => rows?.find((r) => r.tbl === tbl && r.code === code) ?? null;
