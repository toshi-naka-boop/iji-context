// エンジンの指摘を画面に出す文言（UI 文言。禁止語を使わない。点数で「多く取る」方向に誘わない）
// 判定の中身はエンジンが決める。ここは言い方だけ
import type { FactKey, Finding } from "./engine/types";

export const FINDING_TEXT: Record<string, string> = {
  "R01.no_visit": "訪問診療のない月に在医総管が入っています",
  "R01.use_twice_or_more": "訪問診療が月 2 回以上なのに、月 1 回の区分になっています",
  "R01.use_once": "訪問診療が月 1 回なのに、月 2 回以上の区分になっています",
  "R02.use_severe": "別表第八の二に当たる患者なのに、重症区分になっていません",
  "R02.not_severe": "別表第八の二に当たらないのに、重症区分になっています",
  "R02.severe_with_hokatsu": "重症区分に包括的支援加算が付いています",
  "R03.missing": "包括的支援加算の要件を満たしていますが、入っていません",
  "R03.not_eligible": "包括的支援加算の要件（要介護3 以上・重症区分以外）を満たしていません",
  "R04.only_main": "在宅療養指導管理料が 2 つ以上入っています（主たるもの 1 つだけ）",
  "R05.bundled": "在医総管の月に、所定点数に含まれる項目が別に入っています",
  "R05.no_rx_addition_with_rx": "処方箋を出している月に、処方箋を交付しない場合の加算が入っています",
  "R06.excluded_disease": "主病が特定疾患処方管理加算の対象外です",
  "R06.under_28_days": "28 日以上の処方がないのに、特定疾患処方管理加算が入っています",
  "R07.use_seven_or_more": "内服 7 種類以上なので、処方箋料の区分が違います",
  "R07.not_seven_or_more": "内服 7 種類未満なのに、7 種類以上の区分になっています",
  "R08.oushin_only_day": "往診だけの日に、訪問診療時のベースアップ評価料が入っています",
  "R08.use_visit_28": "訪問診療の日に、再診時等のベースアップ評価料が入っています",
  "R09.mitori_with_shibou": "看取り加算と死亡診断加算が両方入っています（併算定できません）",
  "R09.terminal_visits": "在宅ターミナルケア加算の要件（死亡日前 14 日以内に 2 回以上の訪問）を満たしていません",
  "R10.kinkyu_not_eligible": "緊急往診加算の対象患者ではありません",
  "R10.same_day_as_visit": "訪問診療と同じ日に往診料が入っています",
  "R10.visit_day_after_oushin": "往診の翌日に訪問診療が入っています",
  "R11.judgement_once_a_month": "検体検査判断料が月 2 回以上入っています",
  "R11.bnp_is_biochem2": "BNP には生化学的検査(Ⅱ)判断料が要ります",
  "R11.no_rapid_in_home": "訪問診療では外来迅速検体検査加算は入れません",
  "R12.same_month": "在宅医療DX情報活用加算と、同じ月に入れられない加算が両方入っています",
  "R13.over_three_a_week": "週 3 回を超える訪問診療は、別表第七の疾病等か急性増悪のときだけです",
  "R14.missing": "在宅移行早期加算の要件を満たしていますが、入っていません",
  "R14.not_eligible": "在宅移行早期加算の要件（算定開始月から 3 か月目まで、退院から 1 年以内）を満たしていません",
};

/** 足りない事実の名前（画面で入力を求めるときに使う） */
export const FACT_LABEL: Record<FactKey, string> = {
  age: "年齢",
  insurance: "保険",
  burdenRatio: "負担割合",
  careLevel: "要介護度",
  table7: "別表第七に当たるか",
  table8_2: "別表第八の二に当たるか",
  mainDisease: "主病",
  homeOxygen: "在宅酸素療法中か",
  deathPlace: "看取りの場所",
  visitsComplete: "訪問の記録がそろっているか",
  acuteExacerbation: "急性増悪か",
  emergencyEligible: "緊急往診の対象患者か",
};

/** 確認してほしい点の文。情報不足は「どこを確かめるか」を添える（医療事務あては本人、医師あては医師確認） */
export function findingText(f: Finding): string {
  if (f.kind === "情報不足" && f.missing) {
    const label = FACT_LABEL[f.missing.field as FactKey] ?? f.missing.field;
    return f.missing.target === "doctor"
      ? `${label}がカルテから分かりません。医師確認で確かめましょう`
      : `${label}が入っていません。${f.missing.field === "careLevel" ? "介護保険証で" : ""}確かめて入力してください`;
  }
  return FINDING_TEXT[f.messageKey] ?? f.messageKey;
}
