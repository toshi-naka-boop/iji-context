// 請求ごとに確かめた事実（その月・その日の出来事についての事実。design.md §6-1・§11-5）。
// 患者ごとに確かめた情報（src/patient/facts.ts。月をまたいで残る。居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者かも、そちら）とは別に持つ。判定は、症例・カルテ由来の事実に、残した最新の値を重ねて使う。
// 入るのは、人が確かめて残した値だけ（機械・AI は埋めない）。誰あての事実か（医師か医療事務か）は、エンジンの宛先の表（src/engine/index.ts の targetOfNeed）が決める
import type { Facts } from "../engine/types";
import { exceptionOf, parseHaihanKey, sharedExceptionOf } from "../generic/haihan";
import { isLocalKey } from "../generic/local-pair";

/** 日付ごとに持つ事実（日付 → 真偽。ある日の答えは、ほかの日に効かない） */
export const DATED_FACT_KEYS = ["sameDaySeparate", "sameDayOushinAfterVisit", "rxLongPsychotropic"] as const;
/** 真偽で持つ事実 */
const BOOLEAN_FACT_KEYS = ["dischargeJointGuidance", "rapidSameDayDocumented", "acuteExacerbation"] as const;
/** 看取りの場所（エンジンは「在宅」かどうかだけを読む） */
export const DEATH_PLACES = ["在宅", "在宅以外"] as const;
export const MAX_MAIN_DISEASE = 100;

/** 画面から残せる事実。患者パネルで残す項目（PATIENT_FACT_KEYS）と、人が入力しない項目（年齢・保険・負担割合・visitsComplete）は入れない */
export const CLAIM_FACT_KEYS = [...DATED_FACT_KEYS, ...BOOLEAN_FACT_KEYS, "mainDisease", "deathPlace"] as const;
export type ClaimFactKey = (typeof CLAIM_FACT_KEYS)[number];
export const CLAIM_FACT_SOURCES = ["カルテ", "カルテ以外の記録", "医師に確認"] as const;
export type ClaimFactSource = (typeof CLAIM_FACT_SOURCES)[number];

/**
 * 背反の特例条件の例外の問いの答え（design.md §13-3）：haihan:<HX-nn>:<コード①>:<コード②>（コードは小さい順）。値は選択肢の文字列。
 * 日付は、その問いが日ごと（scope=day）なら算定日、請求ごとなら持たない
 */
export type HaihanFactKey = `haihan:${string}`;
/**
 * 背反の組の院内の知識で「この請求も条件に当たる」と押した事実（design.md §14-3）：local:<知識の id>@<rev>:<コード①>:<コード②>（コードは小さい順）。
 * 日付は、1 日・同時の表は算定日、同一月の表は持たない（知識の表で決まるので、照らすのはサーバーの処理。src/server/app/local-pairs.ts）。
 * 入力の値は「はい」（真）＝押す、「いいえ」（偽）＝取り消す（round-43 codex #4）。残すのは押した人の役割（名前・レベルは画面に出さない）
 */
export type LocalFactKey = `local:${string}`;
export const isLocalFactKey = (key: string): key is LocalFactKey => isLocalKey(key);

/** 取り消しの値（design.md §13-3。C-118）：claim_facts は追記だけの表で、key・date ごとに最新の行を使う。最新がこの値なら「答えなし」 */
export const CLEARED = "__cleared__";

/** date は、日付ごとの事実と、日ごとの例外の問いだけが持つ（ほかは null） */
export type ClaimFactInput = { key: ClaimFactKey | HaihanFactKey | LocalFactKey; date: string | null; value: boolean | string; source: ClaimFactSource };
export type ClaimFact = ClaimFactInput & { claimId: string; checkedAt: string; checkedBy: string };

export const isClaimFactKey = (key: string): key is ClaimFactKey => (CLAIM_FACT_KEYS as readonly string[]).includes(key);
export const isDatedFact = (key: string): boolean => (DATED_FACT_KEYS as readonly string[]).includes(key);
/** 例外の問いの答えの key か（形と、問いのある例外か） */
export const isHaihanFactKey = (key: string): key is HaihanFactKey => {
  const k = parseHaihanKey(key);
  return k !== null && exceptionOf(k.hx)?.ask !== undefined;
};
/** 入力の形：真偽／看取りの場所／文字（主病） */
export const inputKindOf = (key: ClaimFactKey): "boolean" | "deathPlace" | "text" => (key === "deathPlace" ? "deathPlace" : key === "mainDisease" ? "text" : "boolean");

/** その診療年月（"YYYY-MM"）の、実在する日付か */
function inMonth(date: string, yearMonth: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${yearMonth}-`)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** 入力の検査。日付ごとの事実は、その請求の診療年月の日付が要る。値の型は事実ごと */
export function validateClaimFact(f: ClaimFactInput, yearMonth: string): void {
  // 取り消しの印は、利用者の入力としては受け付けない（どの事実でも。印と答えが区別できなくなる。round-36 C-141）
  if (typeof f.value === "string" && f.value.trim() === CLEARED) throw new Error("この値は残せません");
  if (!CLAIM_FACT_SOURCES.includes(f.source)) throw new Error(`確かめ方が選べない値: ${f.source}`);
  if (isLocalFactKey(f.key)) {
    if (f.date !== null && !inMonth(f.date, yearMonth)) throw new Error("この請求の診療年月の日付を選ぶ");
    if (typeof f.value !== "boolean") throw new Error("「条件に当たる」は、押すか取り消すかを選ぶ");
    return;
  }
  if (isHaihanFactKey(f.key)) {
    const ask = exceptionOf(parseHaihanKey(f.key)!.hx)!.ask!;
    if (ask.scope === "day" ? f.date === null || !inMonth(f.date, yearMonth) : f.date !== null) throw new Error(ask.scope === "day" ? "この請求の診療年月の日付を選ぶ" : "この問いに日付は付けない");
    if (typeof f.value !== "string" || !ask.choices.some((c) => c.label === f.value)) throw new Error("選択肢から選ぶ");
    return;
  }
  if (!isClaimFactKey(f.key)) throw new Error(`残せない項目: ${f.key}`);
  if (isDatedFact(f.key)) {
    if (f.date === null || !inMonth(f.date, yearMonth)) throw new Error("この請求の診療年月の日付を選ぶ");
  } else if (f.date !== null) throw new Error(`${f.key} に日付は付けない`);
  const kind = inputKindOf(f.key);
  // 例外の問いと共有する事実（sameDayOushinAfterVisit）は、例外の問いの選択肢（「その他」「判定不能」を含む）の文字列でも答えられる（利用者の判断 2026-11-22）
  const choices = sharedExceptionOf(f.key)?.ask?.choices;
  if (kind === "boolean" && typeof f.value === "string" && choices) {
    if (!choices.some((c) => c.label === f.value)) throw new Error("選択肢から選ぶ");
  } else if (kind === "boolean" && typeof f.value !== "boolean") throw new Error(`${f.key} は、はい・いいえで選ぶ`);
  if (kind === "deathPlace" && !(DEATH_PLACES as readonly unknown[]).includes(f.value)) throw new Error("看取りの場所は、在宅か在宅以外から選ぶ");
  if (kind === "text" && (typeof f.value !== "string" || f.value.trim() === "" || f.value.length > MAX_MAIN_DISEASE)) throw new Error(`主病は 1〜${MAX_MAIN_DISEASE} 文字で入れる`);
}

/**
 * 症例・カルテ由来の事実に、残した最新の値を重ねる。日付ごとの事実は、その日の答えだけを足す（ほかの日は元のまま）。
 * 最新が取り消し（CLEARED）の事実は「答えなし」にする（日付ごとの事実は、その日を不明に戻す。前の答えは戻らない）。例外の問いの答え（haihan:*）は重ねない（G05 が answers で読む）
 */
export function applyClaimFacts(facts: Facts, latest: Pick<ClaimFact, "key" | "date" | "value">[]): Facts {
  const out: Facts = { ...facts };
  for (const f of latest) {
    if (!isClaimFactKey(f.key)) continue;
    if (f.key === "sameDaySeparate" || f.key === "sameDayOushinAfterVisit" || f.key === "rxLongPsychotropic") {
      const cur = out[f.key];
      const value: Record<string, boolean> = { ...(cur.known ? cur.value : {}) };
      if (f.value === CLEARED) delete value[f.date as string];
      else value[f.date as string] = f.value as boolean;
      out[f.key] = { known: true, value };
    } else if (f.value === CLEARED) out[f.key] = { known: false };
    else if (f.key === "mainDisease" || f.key === "deathPlace") out[f.key] = { known: true, value: f.value as string };
    else out[f.key] = { known: true, value: f.value as boolean };
  }
  return out;
}
