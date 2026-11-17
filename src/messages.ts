// エンジンの指摘を画面に出す文言（UI 文言。禁止語を使わない。点数で「多く取る」方向に誘わない）
// 判定の中身はエンジンが決める。ここは言い方だけ
import type { FacilityFactKey, FactKey, Finding, NeedKey, Payer } from "./engine/types";
import type { PatientFinding } from "./patient/checks";

export const FINDING_TEXT: Record<string, string> = {
  "R01.no_visit": "訪問診療料のない月に、管理料が入っています",
  "R01.use_twice_or_more": "訪問診療料が月 2 回以上なのに、月 1 回の区分になっています",
  "R01.use_once": "訪問診療料が月 1 回なのに、月 2 回以上の区分になっています",
  "R01.note16_once_rate": "この施設は注16 の基準を満たしていないので、月 2 回以上でも月 1 回の区分（2ニ）で算定します",
  "R02.use_severe": "別表第八の二に当たる患者なのに、重症区分になっていません",
  "R02.not_severe": "別表第八の二に当たらないのに、重症区分になっています",
  "R02.severe_with_hokatsu": "重症区分で算定する月に、包括的支援加算が入っています。加算の行を外してください",
  "R03.missing": "包括的支援加算の要件を満たしていますが、入っていません",
  "R03.not_eligible": "包括的支援加算の要件（要介護3 以上）を満たしていません",
  "R04.only_main": "在宅療養指導管理料が 2 つ以上入っています（主たるもの 1 つだけ）",
  "R05.bundled": "管理料の月に、所定点数に含まれる項目が別に入っています",
  "R05.no_rx_addition_with_rx": "処方箋を出している月に、処方箋を交付しない場合の加算が入っています",
  "R06.excluded_disease": "主病が特定疾患処方管理加算の対象外です",
  "R06.under_28_days": "28 日以上の処方がないのに、特定疾患処方管理加算が入っています",
  "R07.use_seven_or_more": "内服 7 種類以上なので、処方箋料の区分が違います",
  "R07.not_seven_or_more": "内服 7 種類未満なのに、7 種類以上の区分になっています",
  "R08.oushin_only_day": "訪問診療料のない日に、訪問診療時のベースアップ評価料が入っています",
  "R08.use_visit": "訪問診療料の日に、再診時等のベースアップ評価料が入っています",
  "R08.no_revisit_on_both_day": "訪問診療料と往診料の両方がある日に、再診時等のベースアップ評価料が重なっています。この行は算定できないので外してください",
  "R09.mitori_with_shibou": "看取り加算と死亡診断加算が両方入っています（併算定できません）",
  "R09.terminal_visits": "在宅ターミナルケア加算の要件（死亡日前 14 日以内に 2 回以上の訪問）を満たしていません",
  "R10.kinkyu_not_eligible": "緊急往診加算の対象患者ではありません",
  "R10.same_encounter": "1 回の診療に、訪問診療料と往診料の両方が入っています。診療の中身に合うほうだけを残してください",
  "R10.same_day_as_visit": "往診料と同じ日の訪問診療料は、連絡先などの文書を提供している患者でなければ算定できません",
  "R10.visit_day_after_oushin": "往診料の翌日の訪問診療料は、連絡先などの文書を提供している患者でなければ算定できません",
  "R11.judgement_once_a_month": "検体検査判断料が月 2 回以上入っています",
  "R11.bnp_is_biochem2": "BNP には生化学的検査(Ⅱ)判断料が要ります",
  "R11.rapid_needs_same_day_doc": "外来迅速検体検査加算には、当日中の結果の説明と文書の提供が要ります。記録がなければ行を外してください",
  "R12.same_month": "在宅医療DX情報活用加算と、同じ月に入れられない加算が両方入っています",
  "R12.dx_tier": "在宅医療DX情報活用加算の区分が、届出の区分と違います",
  "R12.dx_not_notified": "在宅医療DX情報活用加算の届出がないのに、加算が入っています",
  "R13.over_three_a_week": "週 3 回を超える訪問診療料は、別表第七の疾病等か急性増悪のときだけです",
  "R14.missing": "在宅移行早期加算の要件を満たしていますが、入っていません",
  "R14.not_eligible": "在宅移行早期加算の要件（算定開始月から 3 か月目まで、退院から 1 年以内）を満たしていません",
  "R15.oushin_only_day": "訪問診療料のない日に、訪問診療時の物価対応料が入っています",
  "R15.use_visit": "訪問診療料の日に、再診時等の物価対応料が入っています",
  "R15.no_revisit_on_both_day": "訪問診療料と往診料の両方がある日に、再診時等の物価対応料が重なっています。この行は算定できないので外してください",
  "R16.use_shisetsu": "施設に入居している患者なので、在医総管ではなく施設入居時等医学総合管理料で算定します",
  "R16.use_zaii": "居宅の患者なので、施設入居時等医学総合管理料ではなく在医総管で算定します",
};

/**
 * 審査支払機関の表示名（design.md §8 L-26、EM #8-5）。内部の名前（"支払基金"）は変えず、画面に出すときだけ今の名称にする
 */
export const PAYER_LABEL: Record<Payer, string> = { 支払基金: "DX審査支払機構（旧 支払基金）", 国保連: "国保連" };
export const payerLabel = (payer: string | null | undefined): string => (payer ? (PAYER_LABEL[payer as Payer] ?? payer) : "");

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
  residence: "居住の場所（居宅か、施設に入居しているか）",
  contactDocProvided: "連絡担当者・往診担当医などの文書を患者に提供しているか",
  sameDaySeparate: "同じ日の訪問診療料と往診料が、別々の診療のものか",
  rapidSameDayDocumented: "検査の結果を当日中に説明し、文書で提供した記録があるか",
  comprehensiveCare: "管理料（在医総管・施設総管）を算定する患者か",
};

/** 足りない施設の設定の名前（施設の設定で確かめるよう案内する。design.md §6-1） */
export const FACILITY_LABEL: Record<FacilityFactKey, string> = {
  dxTier: "在宅医療DX情報活用加算の届出の区分",
  baseUp: "ベースアップ評価料の届出の区分",
  priceResponse: "物価対応料を算定するか",
  note16Met: "管理料の注16 の基準を満たしているか",
  revisitBaseUpSameDay: "訪問診療料と往診料の両方がある日に、再診時等のベースアップ評価料を重ねて算定できるか",
  revisitPriceSameDay: "訪問診療料と往診料の両方がある日に、再診時等の物価対応料を重ねて算定できるか",
};

/** 足りない入力（患者の事実か、施設の設定）の名前 */
export const needLabel = (key: NeedKey): string =>
  key.startsWith("facility.") ? `施設の設定「${FACILITY_LABEL[key.slice("facility.".length) as FacilityFactKey] ?? key}」` : (FACT_LABEL[key as FactKey] ?? key);

/** 算定行の導出規則（design.md §2-8 の D01〜D12）を、根拠として画面に出す文 */
export const DERIVE_TEXT: Record<string, string> = {
  D01: "訪問診療の記録 1 件につき 1 回",
  D02: "往診の記録 1 件につき 1 回",
  D03: "その月の訪問診療料の回数と、患者の状態・居住の場所・施設の基準で決まる区分",
  D04: "管理料が月 2 回以上（重症以外）か月 1 回の区分で、要介護 3 以上",
  D05: "退院後に在宅療養を始め、管理料の算定開始月から 3 か月目まで",
  D06: "訪問診療料を算定した月に 1 回（届出の区分による）",
  D07: "訪問診療料の日は訪問診療時の区分、往診料だけの日は再診時等の区分",
  D08: "訪問診療料の日は訪問診療時の区分、往診料だけの日は再診時等の区分",
  D09: "検査の項目ごとに 1 回。血液採取は検査の日ごとに 1 回、判断料は区分ごとに月 1 回",
  D10: "管理料を算定しない月の処方。内服の種類数で区分が決まる",
  D11: "本人が選んだ",
  D12: "本人が選んだ（死亡日前 14 日以内に 2 回以上の訪問・往診の記録がある）",
};

/** 確認してほしい点の文。情報不足は「どこを確かめるか」を添える（医療事務あては本人、医師あては医師確認） */
export function findingText(f: Finding): string {
  if (f.kind === "情報不足" && f.missing) {
    if (f.missing.field.startsWith("facility.")) {
      const label = FACILITY_LABEL[f.missing.field.slice("facility.".length) as FacilityFactKey] ?? f.missing.field;
      return `施設の設定「${label}」が入っていません。事務長か責任者に確かめて、施設の設定に入力してください`;
    }
    const label = FACT_LABEL[f.missing.field as FactKey] ?? f.missing.field;
    const day = f.missing.date ? `（${Number(f.missing.date.slice(5, 7))}月${Number(f.missing.date.slice(8, 10))}日）` : "";
    return f.missing.target === "doctor"
      ? `${label}がカルテから分かりません。医師確認で確かめましょう`
      : `${label}${day}が入っていません。${f.missing.field === "careLevel" ? "介護保険証で" : ""}確かめて入力してください`;
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
  "P07.missing": "要介護度に有効期間が入っていません。介護保険証で要介護認定の有効期間を確かめてください",
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
