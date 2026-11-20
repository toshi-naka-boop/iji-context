// 請求ごとに確かめた事実（その月・その日の出来事についての事実。design.md §6-1・§11-5）。
// 患者ごとに確かめた情報（src/patient/facts.ts。月をまたいで残る。居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者かも、そちら）とは別に持つ。判定は、症例・カルテ由来の事実に、残した最新の値を重ねて使う。
// 入るのは、人が確かめて残した値だけ（機械・AI は埋めない）。誰あての事実か（医師か医療事務か）は、エンジンの宛先の表（src/engine/index.ts の targetOfNeed）が決める
import type { Facts } from "../engine/types";

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

/** date は、日付ごとの事実だけが持つ（ほかは null） */
export type ClaimFactInput = { key: ClaimFactKey; date: string | null; value: boolean | string; source: ClaimFactSource };
export type ClaimFact = ClaimFactInput & { claimId: string; checkedAt: string; checkedBy: string };

export const isClaimFactKey = (key: string): key is ClaimFactKey => (CLAIM_FACT_KEYS as readonly string[]).includes(key);
export const isDatedFact = (key: string): boolean => (DATED_FACT_KEYS as readonly string[]).includes(key);
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
  if (!isClaimFactKey(f.key)) throw new Error(`残せない項目: ${f.key}`);
  if (!CLAIM_FACT_SOURCES.includes(f.source)) throw new Error(`確かめ方が選べない値: ${f.source}`);
  if (isDatedFact(f.key)) {
    if (f.date === null || !inMonth(f.date, yearMonth)) throw new Error("この請求の診療年月の日付を選ぶ");
  } else if (f.date !== null) throw new Error(`${f.key} に日付は付けない`);
  const kind = inputKindOf(f.key);
  if (kind === "boolean" && typeof f.value !== "boolean") throw new Error(`${f.key} は、はい・いいえで選ぶ`);
  if (kind === "deathPlace" && !(DEATH_PLACES as readonly unknown[]).includes(f.value)) throw new Error("看取りの場所は、在宅か在宅以外から選ぶ");
  if (kind === "text" && (typeof f.value !== "string" || f.value.trim() === "" || f.value.length > MAX_MAIN_DISEASE)) throw new Error(`主病は 1〜${MAX_MAIN_DISEASE} 文字で入れる`);
}

/** 症例・カルテ由来の事実に、残した最新の値を重ねる。日付ごとの事実は、その日の答えだけを足す（ほかの日は元のまま） */
export function applyClaimFacts(facts: Facts, latest: Pick<ClaimFact, "key" | "date" | "value">[]): Facts {
  const out: Facts = { ...facts };
  for (const f of latest) {
    if (f.key === "sameDaySeparate" || f.key === "sameDayOushinAfterVisit" || f.key === "rxLongPsychotropic") {
      const cur = out[f.key];
      out[f.key] = { known: true, value: { ...(cur.known ? cur.value : {}), [f.date as string]: f.value as boolean } };
    } else if (f.key === "mainDisease" || f.key === "deathPlace") out[f.key] = { known: true, value: f.value as string };
    else out[f.key] = { known: true, value: f.value as boolean };
  }
  return out;
}
