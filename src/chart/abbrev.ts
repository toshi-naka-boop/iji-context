// 分からない略語に印を付ける（spec FR-211。design/iji-context/plan-fr211.md の「何を作るか」1）。決まった規則だけで行い、LLM の確信度は使わない。
// 語の切り方：原文を NFKC にし、英字の並びに続く数字までを 1 語（ECG12・FT4・SpO2）として、2 文字以上の語だけを見る。大文字・小文字は区別する（Af と AF は別の語）。
// 分かる語：診療年月の 1 枚の基本マスター 4 本（医科診療行為・医薬品・特定器材・傷病名）の名称を同じ切り方で切った語と、固定の一覧（config/abbrev-known.json）の語。
// どちらでもない語に印を付ける。マスターがない・版のない診療年月は印を付けない（全部を聞かない。「見ていません」の文を出す）。原文は書き換えない
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import known from "../../config/abbrev-known.json";
import { askedAct, askedChild, tableKeyOfAct, tableKeyOfChild, type ChartAct, type StoredActs, type TableKey } from "./acts";
import type { ExtractedFact } from "./extract";
import { hasRevision, resolveRevision } from "../engine/revisions";
import { pickSnapshot, type MastersDb } from "../masters/db";
import { normName } from "../notice/notice";

/** 1 語の形：英字の並びと、それに続く数字 */
const TOKEN = /[A-Za-z]+[0-9]*/g;
/** 固定の一覧（単位・バイタル。利用者の承認つき） */
export const KNOWN_WORDS: ReadonlySet<string> = new Set(known.words);
/** マスターがないときに出す文 */
export const NO_MASTER_NOTE = "マスターがないので略語は見ていません";

/** 文から切り出した語（2 文字以上。出た順に、同じ語は 1 回） */
export function abbrevTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(TOKEN)) if (m[0].length >= 2 && !out.includes(m[0])) out.push(m[0]);
  return out;
}

/** 分かる語の集合（マスターの名称の語）と、傷病名の名称（normName）。病名の記載の完全一致に使う */
export type AbbrevVocab = { words: Set<string>; diseases: Set<string> };

const TABLES = ["shinryo", "iyakuhin", "tokutei", "shobyo"] as const;
const memo = new WeakMap<MastersDb, Map<string, AbbrevVocab>>();
const fileMemo = new Map<string, AbbrevVocab>();

/**
 * 診療年月の 1 枚の基本マスター 4 本から、分かる語の集合を作る。4 本のどれかの 1 枚がない・版のない診療年月は null（印を付けない）。
 * 同じファイル・同じ 1 枚の組なら作り直さない
 */
export function abbrevVocabOf(db: MastersDb | null, yearMonth: string): AbbrevVocab | null {
  if (!db || !hasRevision(yearMonth)) return null;
  const generation = resolveRevision(yearMonth).generation;
  const snaps: string[] = [];
  for (const t of TABLES) {
    const s = pickSnapshot(db, t, yearMonth, generation);
    if (!s) return null;
    snaps.push(s.snapshot);
  }
  const build = (): AbbrevVocab => {
    const words = new Set<string>();
    const diseases = new Set<string>();
    TABLES.forEach((t, i) => {
      for (const r of db.prepare(`SELECT name FROM ${t} WHERE snapshot = ?`).all(snaps[i]) as { name: string }[]) {
        for (const w of abbrevTokens(r.name)) words.add(w);
        if (t === "shobyo") diseases.add(normName(r.name));
      }
    });
    return { words, diseases };
  };
  const k = snaps.join("|");
  if (db.memory) {
    const m = memo.get(db) ?? new Map<string, AbbrevVocab>();
    memo.set(db, m);
    if (!m.has(k)) m.set(k, build());
    return m.get(k)!;
  }
  // 作り直した masters.db（更新時刻が変わった）の古い集合は捨てる
  const file = `${db.name}|${statSync(db.name).mtimeMs}|`;
  if (!fileMemo.has(file + k)) {
    for (const old of [...fileMemo.keys()]) if (old.startsWith(`${db.name}|`) && !old.startsWith(file)) fileMemo.delete(old);
    fileMemo.set(file + k, build());
  }
  return fileMemo.get(file + k)!;
}

/** 文の中の、印の付く語（マスターの名称にも固定の一覧にもない語） */
export const abbrevMarks = (text: string, vocab: AbbrevVocab): string[] => abbrevTokens(text).filter((w) => !vocab.words.has(w) && !KNOWN_WORDS.has(w));

/** 病名の記載が、傷病名マスターの名称と完全に一致するか（normName を両側に掛ける） */
export const diseaseExact = (value: string, vocab: AbbrevVocab): boolean => vocab.diseases.has(normName(value));

const flat = (t: string) => t.normalize("NFKC").replace(/\s+/g, "");
/** 言い換えの疑い：書かれた名前・値が引用の中にそのまま含まれていない（NFKC・空白を除いて比べる。反証 round-97 C-631） */
export const paraphrased = (written: string, quote: string): boolean => !flat(quote).includes(flat(written));
/** 言い換えのない記載の印：書かれた名前・値の語だけで決める（名称の完全一致があれば付けない。引用のほかの語は足さない。C-632） */
export const directMarks = (written: string, vocab: AbbrevVocab, exact: boolean): string[] => (exact ? [] : abbrevMarks(written, vocab));

/**
 * その日の行ったこと・事実の印を付け直す（保存のとき・取り出した直後。決まった規則 1 本。反証 round-96 X-490・round-97 C-631・C-632）。
 * - 書かれた名前・値が引用の中にそのまま含まれる記載（言い換えなし）：その名前・値の語だけで印を決める
 * - 含まれない記載（言い換えの疑い）：その日の原文（text）の分からない略語のうち、言い換えなしの記載の名前・値に出てこない語を印にする。
 *   そういう語がなければ、記載そのもの（書かれた名前・値）を問いの語にする。言い換えの疑いの記載は、いつも医師に聞く（自動選択も lookup もしない）
 * 聞く行為・子の lookup は空にする（推し量りを見せない・残さない）。病名の記載は値が傷病名の名称と完全に一致すれば値の印を見ない
 */
export function markDay(acts: ChartAct[], facts: ExtractedFact[], vocab: AbbrevVocab, exact: (key: TableKey, written: string) => boolean, text: string): { acts: ChartAct[]; facts: ExtractedFact[] } {
  type X = { written: string; quote: string };
  const items: X[] = [...acts.flatMap((a) => [a, ...(a.with ?? [])]), ...facts.map((f) => ({ written: f.value, quote: f.quote }))];
  const explained = new Set(items.filter((x) => !paraphrased(x.written, x.quote)).flatMap((x) => abbrevTokens(x.written)));
  const unexplained = abbrevMarks(text, vocab).filter((w) => !explained.has(w));
  const marksOf = (x: X, isExact: boolean): string[] => (paraphrased(x.written, x.quote) ? (unexplained.length > 0 ? unexplained : [x.written.trim()]) : directMarks(x.written, vocab, isExact));
  const outActs = acts.map((a) => {
    const { abbrev: _a, ...rest } = a;
    const m = marksOf(a, exact(tableKeyOfAct(a.category), a.written));
    const act: ChartAct = m.length > 0 ? { ...rest, abbrev: m } : rest;
    if (askedAct(act)) act.lookup = [];
    if (a.with)
      act.with = a.with.map((c) => {
        const { abbrev: _c, ...cr } = c;
        const cm = marksOf(c, exact(tableKeyOfChild(c.kind), c.written));
        const child = cm.length > 0 ? { ...cr, abbrev: cm } : cr;
        return askedChild(act, child) ? { ...child, lookup: [] } : child;
      });
    return act;
  });
  const outFacts = facts.map((f) => {
    const { abbrev: _a, ...rest } = f;
    const m = marksOf({ written: f.value, quote: f.quote }, f.kind === "病名の記載" && diseaseExact(f.value, vocab));
    return (m.length > 0 ? { ...rest, abbrev: m } : rest) as ExtractedFact;
  });
  return { acts: outActs, facts: outFacts };
}

/** 記載の指紋（書かれた名前・値と引用。位置の番号は保存し直すとずれるので使わない） */
export const itemKeyOf = (written: string, quote: string): string => createHash("sha256").update(`${written}\0${quote}`).digest("hex").slice(0, 16);

/** 医師に聞く記載 1 つ。place：act＝行為／child＝行為で使った薬・器材／fact＝病名の記載。index・child は今の位置（候補を出すため。同定には key を使う） */
export type AbbrevItem = { place: "act" | "child" | "fact"; index: number; child?: number; written: string; quote: string; tokens: string[]; key: string };

/**
 * 保存したカルテの、医師に聞く記載（決まった規則）：聞く行為・子と、訪問カルテの病名の記載で印のあるもの。
 * 貼ったカルテ（記録）は事実を使わないので、行為だけを聞く
 */
export function askedItems(kind: string, stored: StoredActs | null, facts: ExtractedFact[] | null): AbbrevItem[] {
  const out: AbbrevItem[] = [];
  (stored?.acts ?? []).forEach((a, index) => {
    if (askedAct(a)) out.push({ place: "act", index, written: a.written, quote: a.quote, tokens: a.abbrev!, key: itemKeyOf(a.written, a.quote) });
    (a.with ?? []).forEach((c, child) => {
      if (askedChild(a, c)) out.push({ place: "child", index, child, written: c.written, quote: c.quote, tokens: c.abbrev!, key: itemKeyOf(c.written, c.quote) });
    });
  });
  if (kind !== "記録")
    (facts ?? []).forEach((f, index) => {
      if (f.kind === "病名の記載" && (f.abbrev?.length ?? 0) > 0) out.push({ place: "fact", index, written: f.value, quote: f.quote, tokens: f.abbrev!, key: itemKeyOf(f.value, f.quote) });
    });
  return out;
}
