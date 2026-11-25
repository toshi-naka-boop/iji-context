// 同梱の作り物（合成データ）から生まれた記録を見分ける印（2026-11-22 利用者の判断「印で除外する」）。
// 実在のデータで使うクリニック（と未定のクリニック）では、これに当たる知識・請求を、判断・会議・トリガー・一覧の対象から外す。状態と history は変えない。
// 見分け方はコードで確かめた印だけを使い、推し量らない：
// - 院内ルールの種：source_event.ref が "seed:" で始まる（src/lifecycle/seed-local.ts の SEED_REF）
// - K6 の地域ルール：見本の通知から作った知識。通知の知識の ref は「<査定|返戻>:<請求 id>:<診療年月>:<区分>」（src/notice/notice.ts の candidateOf）で、
//   請求 id が同梱の見本の患者（fixtures/uke/patients.json。合成データ）の請求のもの
// - 見本の請求：請求 id が同梱の見本の患者の請求のもの（K1〜K7。取り込んだ UKE の請求 id は U…）
import PATIENTS from "../../fixtures/uke/patients.json";
import { SEED_REF } from "../lifecycle/seed-local";
import type { KnowledgeMeta } from "../lifecycle/types";

const SAMPLE_CLAIMS: ReadonlySet<string> = new Set(Object.keys(PATIENTS.patients));

/** 同梱の見本の請求か */
export const isSampleClaim = (claimId: string): boolean => SAMPLE_CLAIMS.has(claimId);

/** 同梱の作り物から生まれた知識か（院内ルールの種と、見本の通知から作った地域ルール） */
export function isSampleKnowledge(m: Pick<KnowledgeMeta, "layer" | "source_event">): boolean {
  const { type, ref } = m.source_event;
  if (ref.startsWith(SEED_REF)) return true;
  if (m.layer !== "地域" || (type !== "査定" && type !== "返戻")) return false;
  const [outcome, claimId] = ref.split(":");
  return outcome === type && claimId !== undefined && isSampleClaim(claimId);
}
