// 略語の意味の候補を引く辞書（spec FR-211。plan-fr211.md「辞書方式の決め」1・5）。決まった規則だけで引き、LLM は使わない。
// 万病辞書 MANBYO（CC BY 4.0。masters.db の manbyo の表。手で raw/ に置いて取り込む）と、クリニックの辞書（医師の答えから書き足した行。app.db の abbrev_dictionary）。
// どちらも候補にだけ使い、一致しても正しいとはみなさない。出現形は NFKC にして引き、大文字と小文字を分ける（AF＝心房細動、Af＝心室細動）
import { statSync } from "node:fs";
import { MASTERS_CONFIG } from "../masters/config";
import type { MastersDb } from "../masters/db";

/** 意味の候補 1 つ。source は出どころ、reliability は万病辞書の信頼度レベル（S・A〜F） */
export type DictMeaning = { meaning: string; source: "万病辞書" | "クリニックの辞書"; reliability?: string };

/** 万病辞書の出典の表示（config/masters.json の license。画面と README に出す） */
export const MANBYO_CREDIT = MASTERS_CONFIG.datasets.manbyo?.license ?? null;

/** 標準病名の欄を意味の並びにする：「;」で分け、「-1」と空は「意味なし」として外す */
export const meaningsOf = (name: string): string[] => [...new Set(name.split(";").map((x) => x.trim()).filter((x) => x !== "" && x !== "-1"))];

const ABBREV = /^[A-Za-z]+[0-9]*$/;
type Entry = { meanings: string[]; reliability: string };
const memo = new WeakMap<MastersDb, Map<string, Map<string, Entry>>>();
const fileMemo = new Map<string, Map<string, Entry>>();

/** 取り込んだ万病辞書のいちばん新しい 1 枚（改定の世代によらない。なければ null） */
const latestSnapshot = (db: MastersDb): string | null =>
  (db.prepare("SELECT snapshot FROM sources WHERE dataset = 'manbyo' ORDER BY snapshot DESC LIMIT 1").get() as { snapshot: string } | undefined)?.snapshot ?? null;

/** 万病辞書の、英字の略語の形の出現形（NFKC）→ 意味と信頼度。辞書を取り込んでいなければ null */
export function manbyoOf(db: MastersDb | null): Map<string, Entry> | null {
  if (!db) return null;
  let snap: string | null;
  try {
    snap = latestSnapshot(db);
  } catch {
    return null;
  }
  if (!snap) return null;
  const build = () => {
    const out = new Map<string, Entry>();
    for (const r of db.prepare("SELECT surface, name, reliability FROM manbyo WHERE snapshot = ?").all(snap) as { surface: string; name: string; reliability: string }[]) {
      const token = r.surface.normalize("NFKC");
      if (ABBREV.test(token)) out.set(token, { meanings: meaningsOf(r.name), reliability: r.reliability });
    }
    return out;
  };
  if (db.memory) {
    const m = memo.get(db) ?? new Map<string, Map<string, Entry>>();
    memo.set(db, m);
    if (!m.has(snap)) m.set(snap, build());
    return m.get(snap)!;
  }
  const k = `${db.name}|${statSync(db.name).mtimeMs}|${snap}`;
  if (!fileMemo.has(k)) {
    for (const old of [...fileMemo.keys()]) if (old.startsWith(`${db.name}|`)) fileMemo.delete(old);
    fileMemo.set(k, build());
  }
  return fileMemo.get(k)!;
}

/**
 * 略語の意味の候補（万病辞書の意味の後に、クリニックの辞書の意味。同じ意味は 1 回）。
 * inDict は、どちらかの辞書に意味が 1 つでもあるか（出現形があっても意味なしの語は、辞書にない語として扱う）
 */
export function candidatesOf(token: string, manbyo: Map<string, Entry> | null, clinic: readonly string[]): { inDict: boolean; candidates: DictMeaning[] } {
  const out: DictMeaning[] = [];
  const e = manbyo?.get(token);
  for (const m of e?.meanings ?? []) out.push({ meaning: m, source: "万病辞書", reliability: e!.reliability });
  for (const m of clinic) if (!out.some((x) => x.meaning === m)) out.push({ meaning: m, source: "クリニックの辞書" });
  return { inDict: out.length > 0, candidates: out };
}
