// エンジンの指摘を画面に出す文言（UI 文言。禁止語を使わない。点数で「多く取る」方向に誘わない）
// 判定の中身はエンジンが決める。ここは言い方だけ
import type { FactKey, Finding } from "./engine/types";
import type { PatientFinding } from "./patient/checks";

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

/**
 * 患者情報チェック（P01〜P08。src/patient/checks.ts）の文言。ユスティの指摘とは別の欄に出す。
 * 医療事務が次に何を確かめればよいかを書く。断定できないものは「確かめてください」にとどめる
 */
export const PATIENT_FINDING_TEXT: Record<string, string> = {
  "P01.insurer_length": "保険者番号の桁数が合いません。資格情報で番号を確かめてください",
  "P01.insurer_check_digit": "保険者番号の検証番号が合いません。資格情報で番号を確かめてください",
  "P01.kohi_payer_length": "公費負担者番号の桁数が合いません。受給者証で番号を確かめてください",
  "P01.kohi_payer_check_digit": "公費負担者番号の検証番号が合いません。受給者証で番号を確かめてください",
  "P01.recipient_length": "受給者番号の桁数が合いません。受給者証で番号を確かめてください",
  "P01.recipient_check_digit": "受給者番号の検証番号が合いません。受給者証で番号を確かめてください",
  "P02.late_elderly_under_65": "後期高齢者医療の番号ですが、生年月日では 65 歳未満です。生年月日と資格情報を確かめてください",
  "P02.late_elderly_65_74": "65〜74 歳で後期高齢者医療になっています。障害の認定による加入か、資格情報で確かめてください",
  "P02.over_75_not_late_elderly": "75 歳以上ですが、後期高齢者医療の番号ではありません。生年月日と資格情報を確かめてください",
  "P03.missing": "負担割合が入っていません。資格情報で確かめて入力してください",
  "P03.late_elderly_ratio": "後期高齢者医療の負担割合は 1 割・2 割・3 割のいずれかです。資格情報で確かめてください",
  "P03.age_70_74_ratio": "70〜74 歳の負担割合は 2 割か 3 割です。資格情報で確かめてください",
  "P03.receipt_type_ratio": "負担割合とレセプト種別が合っていません。資格情報の負担割合と、レセコンの登録を確かめてください",
  "P04.insurance_kind": "レセプト種別と保険の種類が合っていません。レセコンの保険の登録を確かめてください",
  "P04.kohi_count": "レセプト種別と公費の数が合っていません。受給者証と、レセコンの公費の登録を確かめてください",
  "P04.age": "レセプト種別と年齢が合っていません。生年月日と、レセコンの保険の登録を確かめてください",
  "P05.order": "公費の順番を確かめてください（法別番号 {first} は {second} より先に書きます）",
  "P06.no_valid_insurance": "この月に有効な医療保険の加入情報がありません。資格情報を確かめてください",
  "P06.overlap": "この月に有効な医療保険が 2 件以上あります。それぞれの有効期間を確かめて入力してください",
  "P06.no_period_insurance": "資格の有効期限が入っていません。資格情報で有効期間を確かめて入力してください",
  "P06.no_period_kohi": "受給者証の有効期限が入っていません。受給者証で有効期間を確かめて入力してください",
  "P06.outside_period": "有効期間の外に診療日があります。診療日の時点の資格を確かめてください",
  "P06.expired": "有効期限を過ぎています。新しい資格情報を確かめて入力してください",
  "P06.mid_month": "月の途中で有効期間が切り替わります。診療日が期間の中か確かめてください",
  "P07.missing": "介護保険証で要介護認定の有効期間を確かめてください",
  "P07.expired": "要介護認定の有効期間が切れています。介護保険証で新しい認定を確かめてください",
  "P07.expiring_soon": "要介護認定の有効期間がもうすぐ切れます。更新の状況を確かめてください",
  "P08.name_missing": "氏名が入っていません。レセコンの患者登録を確かめてください",
  "P08.birth_format": "生年月日が日付として読めません。レセコンの患者登録を確かめてください",
  "P08.birth_future": "生年月日が今日より先の日付です。レセコンの患者登録を確かめてください",
  "P08.sex_code": "性別の記録が読めません。レセコンの患者登録を確かめてください",
};

/** 患者情報チェックの指摘の文。{first} などは params の値に置き換える */
export function patientFindingText(f: Pick<PatientFinding, "messageKey" | "params">): string {
  const text = PATIENT_FINDING_TEXT[f.messageKey] ?? f.messageKey;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => f.params?.[k] ?? "");
}
