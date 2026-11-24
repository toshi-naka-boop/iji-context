// 分からない略語に印を付ける（spec FR-211。design/iji-context/plan-fr211.md の「何を作るか」1）。決まった規則だけで行い、LLM の確信度は使わない。
// 語の切り方：原文を NFKC にし、英字の並びに続く数字までを 1 語（ECG12・FT4・SpO2）として、2 文字以上の語だけを見る。大文字・小文字は区別する（Af と AF は別の語）。
// 分かる語：診療年月の 1 枚の基本マスター 4 本（医科診療行為・医薬品・特定器材・傷病名）の名称を同じ切り方で切った語と、固定の一覧（config/abbrev-known.json）の語。
// どちらでもない語に印を付ける。マスターがない・版のない診療年月は印を付けない（全部を聞かない。「見ていません」の文を出す）。原文は書き換えない
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import known from "../../config/abbrev-known.json";
import { hasRevision, resolveRevision } from "../engine/revisions";
import { pickSnapshot, type MastersDb } from "../masters/db";

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

/** 分かる語の集合（マスターの名称の語） */
export type AbbrevVocab = { words: Set<string> };

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
    TABLES.forEach((t, i) => {
      for (const r of db.prepare(`SELECT name FROM ${t} WHERE snapshot = ?`).all(snaps[i]) as { name: string }[]) {
        for (const w of abbrevTokens(r.name)) words.add(w);
      }
    });
    return { words };
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


/** 原文の、その語を含む文（欄ごとに「。」・改行で切った最初の文。問いの引用に使う。plan-fr211.md「規則の作り直し」2） */
export function sentenceWith(note: { s: string; o: string; a: string; p: string; rx: string }, token: string): string | null {
  for (const field of [note.s, note.o, note.a, note.p, note.rx]) {
    const hit = field
      .split(/(?<=[。\n])/)
      .map((x) => x.trim())
      .find((x) => abbrevTokens(x).includes(token));
    if (hit) return hit;
  }
  return null;
}

/** 記載の指紋（書かれた語と引用。位置の番号は保存し直すとずれるので使わない） */
export const itemKeyOf = (written: string, quote: string): string => createHash("sha256").update(`${written}\0${quote}`).digest("hex").slice(0, 16);

/** 医師に聞く記載 1 つ：事務が医師確認に回した、カルテの略語（place は text。quote は原文のその語を含む文） */
export type AbbrevItem = { place: "text"; index: number; written: string; quote: string; tokens: string[]; key: string };
