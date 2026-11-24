// エンジンの指摘を画面に出す文言（UI 文言。禁止語を使わない。点数で「多く取る」方向に誘わない）
// 判定の中身はエンジンが決める。ここは言い方だけ
import type { FacilityFactKey, FactKey, Finding, NeedKey, Payer } from "./engine/types";
import type { PendingReason } from "./engine/derive";
import type { GenericFinding, GenericNotRun } from "./generic/types";
import type { TriggerKind } from "./lifecycle/types";
import type { PatientFinding } from "./patient/checks";

export const FINDING_TEXT: Record<string, string> = {
  "R01.no_visit": "訪問診療料のない月に、管理料が入っています",
  "R01.use_twice_or_more": "訪問診療料が月 2 回以上なのに、月 1 回の区分になっています",
  "R01.use_once": "訪問診療料が月 1 回なのに、月 2 回以上の区分になっています",
  "R01.note16_once_rate": "この施設は注16 の基準を満たしていないので、月 2 回以上でも月 1 回の区分で算定します",
  // 申告だけを根拠に点数の高い区分へ直さない（design.md §15-4。round-51 C-251）。情報不足として出す
  "R01.declaration_conflict": "申告（注16 の基準を満たす）と請求が食い違っています。申告を確かめてください",
  "R02.use_severe": "別表第八の二に当たる患者なのに、重症区分になっていません",
  "R02.not_severe": "別表第八の二に当たらないのに、重症区分になっています",
  "R02.severe_with_hokatsu": "重症区分で算定する月に、包括的支援加算が入っています。加算の行を外してください",
  "R03.missing": "包括的支援加算の要件を満たしていますが、入っていません",
  "R03.not_eligible": "包括的支援加算の要件（要介護3 以上、障害支援区分2 以上など、別表第八の三の状態）を満たしていません",
  "R04.only_main": "在宅療養指導管理料が 2 つ以上入っています（主たるもの 1 つだけ）",
  "R05.bundled": "管理料の月に、所定点数に含まれる項目が別に入っています",
  "R05.no_rx_addition_with_rx": "処方箋を出している月に、処方箋を交付しない場合の加算が入っています",
  "R06.excluded_disease": "主病が特定疾患処方管理加算の対象外です",
  "R06.under_28_days": "28 日以上の処方がないのに、特定疾患処方管理加算が入っています",
  "R07.use_seven_or_more": "内服 7 種類以上なので、処方箋料の区分が違います",
  "R07.use_long_psychotropic": "向精神薬の長期処方に当たるので、処方箋料の区分が違います",
  "R07.not_seven_or_more": "内服 7 種類未満で、向精神薬の長期処方にも当たらないのに、区分 2 になっています",
  "R08.oushin_only_day": "訪問診療料のない日に、訪問診療時のベースアップ評価料が入っています",
  "R08.use_visit": "訪問診療料の日に、再診時等のベースアップ評価料が入っています",
  "R08.duplicate_on_visit_day": "訪問診療料の日に、訪問診療時のベースアップ評価料と再診時等のベースアップ評価料が重なっています。再診時等の行は算定できないので外してください",
  "R08.no_revisit_on_both_day": "訪問診療料と往診料の両方がある日に、再診時等のベースアップ評価料が重なっています。この行は算定できないので外してください",
  "R09.mitori_with_shibou": "看取り加算と死亡診断加算が両方入っています（併算定できません）",
  "R09.terminal_visits": "在宅ターミナルケア加算の要件（死亡日前 14 日以内に 2 回以上の訪問・往診、又は退院時共同指導料1 の算定と訪問診療）を満たしていません",
  "R10.kinkyu_not_eligible": "緊急往診加算の対象患者ではありません",
  "R10.same_encounter": "1 回の診療に、訪問診療料と往診料の両方が入っています。診療の中身に合うほうだけを残してください",
  "R10.oushin_not_after_visit": "訪問診療料と同じ日の往診料は、訪問診療のあとに、病状の急変などで往診したときでなければ算定できません",
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
  "R15.duplicate_on_visit_day": "訪問診療料の日に、訪問診療時の物価対応料と再診時等の物価対応料が重なっています。再診時等の行は算定できないので外してください",
  "R15.no_revisit_on_both_day": "訪問診療料と往診料の両方がある日に、再診時等の物価対応料が重なっています。この行は算定できないので外してください",
  "R16.use_shisetsu": "施設に入居している患者なので、在医総管ではなく施設入居時等医学総合管理料で算定します",
  "R16.use_zaii": "居宅の患者なので、施設入居時等医学総合管理料ではなく在医総管で算定します",
  // R17 摘要欄の記載。{what} は何の記載か（版の表の要旨）。日付の食い違いは、findingText が足りない日・多い日を後ろに添える
  "R17.comment_missing": "摘要欄に「{what}」の記載がないか、数が足りません",
  "R17.comment_format": "摘要欄の「{what}」の記載が、決められた形（年月日・時刻・数値・文字）で読めません",
  "R17.comment_mismatch_visitDates": "摘要欄の「{what}」が、訪問診療料・往診料を算定した日と合いません",
  "R17.comment_mismatch_acuteVisitDates": "摘要欄の訪問診療を行った年月日に、週の回数の限度を超えた週の訪問診療料の日が足りません",
  "R17.comment_mismatch_deathDate": "摘要欄の死亡年月日が、死亡の記録の日と合いません",
  "R17.comment_mismatch_hokatsuState": "摘要欄の包括的支援加算の状態の記載が、確かめた要介護度・障害支援区分と合いません",
  "R17.comment_mismatch_ikouStart": "摘要欄の初回の管理料を算定した年月日が、管理料の算定開始月と合いません",
  // R18 施設の種別（design.md §15-4）。{fixName} は正しい側の区分の名前、{note} は連携型の申告のときの経過措置の断り（docs M-8）
  "R18.use_grade": "施設の種別と行の区分の種別が違います。施設の種別に合う区分は「{fixName}」です{note}",
  "R18.iko_grade3_only": "在宅療養移行加算は、在宅療養支援診療所以外の診療所（管理料の 3 の区分を算定する患者）に限ります{note}",
  "R18.use_baseup_note5": "ベースアップ評価料(Ⅰ)の注5 の届出があるので、「{fixName}」で算定します{note}",
  "R18.use_baseup_normal": "ベースアップ評価料(Ⅰ)の注5 の届出がないので、「{fixName}」で算定します{note}",
  // 注14（段 17h）。{fixName} は減の行の名称（1 つに決まらないときは両方と注8 の断り）
  "R18.use_note14_reduced": "10 人以上の区分を減算の点数で算定していると申告されています。減算の区分は「{fixName}」です{note8}{note}",
  "R18.note14_conflict": "申告（10 人以上の区分を通常の点数で算定）と請求が食い違っています。申告を確かめてください",
  // R19 単一建物の人数（design.md §15-4。段 17f）。{fixName} はその患者の人数の区分に合う区分の名前
  "R19.use_band": "単一建物診療患者の人数の区分が、行の区分と違います。{fixText}",
  "R19.declaration_conflict": "申告（2 人以上の建物はない）と請求が食い違っています。申告を確かめてください",
  // 介護保険との調整（R20）・ほかの医療機関との調整（R21）。どれも条件つきで、文は前提から始まる（design.md §18-3・§18-4。v37）
  "R20.tokuyou": "{premise}、特養の入所者には、末期の悪性腫瘍か施設での看取りの場合でなければ、訪問診療料・施医総管は算定できません",
  "R20.rouken": "{premise}、老健・介護医療院の入所者には、訪問診療料・在医総管・施医総管は算定できません",
  "R20.ryouyou_visit": "{premise}、短期入所療養介護の期間の訪問診療料（{days}）は算定できません",
  "R20.ryouyou_kanri": "{premise}、訪問診療の日がすべて短期入所療養介護の期間にあるので、在医総管・施医総管は算定できません",
  "R20.seikatsu_family": "{premise}、短期入所生活介護の利用中は、在医総管ではなく施医総管で算定します",
  "R20.seikatsu_prior_kanri": "{premise}、利用前 30 日以内に当院が訪問診療料等を算定していないので、施医総管は算定できません",
  "R20.seikatsu_haichi_kanri": "{premise}、当院の医師は利用先の施設の医師なので、施医総管は算定できません",
  "R20.seikatsu_prior_visit": "{premise}、利用前 30 日以内に当院が訪問診療料等を算定していないので、短期入所生活介護の期間の訪問診療料（{days}）は算定できません",
  "R20.seikatsu_haichi_visit": "{premise}、当院の医師は利用先の施設の医師なので、短期入所生活介護の期間の訪問診療料（{days}）は算定できません",
  "R20.seikatsu_30": "{premise}、短期入所生活介護の利用開始後 30 日を過ぎた日の訪問診療料（{days}）は算定できません",
  "R20.shoutaki_family": "{premise}、小規模多機能型居宅介護・看護小規模多機能型居宅介護の宿泊の利用中は、施医総管ではなく在医総管で算定します",
  "R20.shoutaki_prior_kanri": "{premise}、利用前 30 日以内に当院が訪問診療料等を算定していないので、在医総管は算定できません",
  "R20.shoutaki_haichi_kanri": "{premise}、当院の医師は利用先の施設の医師なので、在医総管は算定できません",
  "R20.shoutaki_prior_visit": "{premise}、利用前 30 日以内に当院が訪問診療料等を算定していないので、宿泊サービスの期間の訪問診療料（{days}）は算定できません",
  "R20.shoutaki_haichi_visit": "{premise}、当院の医師は利用先の施設の医師なので、宿泊サービスの期間の訪問診療料（{days}）は算定できません",
  "R20.shoutaki_30": "{premise}、宿泊サービスの利用開始後 30 日を過ぎた日の訪問診療料（{days}）は算定できません",
  "R20.renkei": "{premise}、要介護・要支援の認定のある患者には、在宅患者連携指導料は算定できません",
  "R21.kanri_one": "{premise}、在医総管・施医総管は主として診療を行う 1 つの医療機関だけが算定します",
  "R21.visit2_count": "{premise}、他の医療機関の求めによる訪問診療料(Ⅰ)2 は月 1 回です（この月は {count} 回）",
  "R21.visit2_6m": "{premise}、求めた日を含む月から 6 月を超える訪問診療料(Ⅰ)2 の算定は、新たな求めか別に定める疾病等の場合に限ります（摘要欄に理由を書きます）",
  "R21.shiji": "{premise}、特別の関係にある医療機関が同じ月に訪問看護・指導料を算定しているので、訪問看護指示料は算定できません",
};

/**
 * 施設の申告から来る値（施設の種別・在支診か・注16・DX の届出の区分・ベースアップ評価料の届出の区分）で結論が変わる指摘の種類（design.md §15-4 の「施設の申告による」。FR-191）。
 * 画面は、文の後ろに BY_DECLARATION_NOTE を添える。漏れは tests/engine/by-declaration.test.ts が縛る（同梱の症例と練習問題の入力で、申告の値を 1 つずつ変えて出る種類が変わるなら、ここに載っていなければならない）
 */
export const BY_DECLARATION = new Set<string>([
  "R01.use_twice_or_more",
  "R01.note16_once_rate",
  "R01.declaration_conflict",
  "R10.same_day_as_visit",
  "R10.visit_day_after_oushin",
  "R12.dx_tier",
  "R12.dx_not_notified",
  "R18.use_grade",
  "R18.iko_grade3_only",
  "R18.use_baseup_note5",
  "R18.use_baseup_normal",
  "R18.use_note14_reduced",
  "R18.note14_conflict",
  "R19.use_band",
  "R19.declaration_conflict",
]);
export const BY_DECLARATION_NOTE = "（施設の申告による）";
/** 施設の申告で決まる施設の設定（情報不足のとき、施設の申告の画面へ案内する。design.md §15-4） */
export const DECLARED_FACILITY_KEYS: FacilityFactKey[] = ["grade", "note16Met", "dxTier", "baseUp", "building", "note14"];
/**
 * 単一建物の人数の入力の案内（design.md §15-4。V-4・V-3）。人数の数え方は EM R8-94 の読み（明文なし。U-22）
 */
export const BUILDING_BAND_GUIDE = "その月に、この建物で在医総管か施医総管を算定する人の数（月の途中で亡くなった人・入居した人も、その月に算定するなら数えます）で、みなしを当てたあとの、請求に使う区分を入れてください（読み〔明文なし〕）";
/** 施設の申告の画面への案内（宛先の値は増やさない。§6-1 の L-44） */
const DECLARATION_GUIDE = "施設の申告の画面で確かめてください（事務長でなければ、事務長に施設の申告を頼んでください）";

/**
 * データで動く点検（G01〜。design.md §12-2）の指摘の文。定型文と値だけ（{code} はコード、{what} は行の種類）。公開元の文章は写さない。
 * G01 は言い切らない：持っているマスターの版のあいだの更新を、全部持っているとは確かめられない
 */
export const GENERIC_TEXT: Record<string, string> = {
  "G01.not_in_any": "コード {code}（{what}）は、持っているどの版のマスターにもありません。打ち間違いか、マスターの更新もれを確かめてください",
  "G01.only_before": "コード {code}（{what}）は、持っているマスターのうち、診療年月の前の版にだけあります。診療年月に使えるコードか、告示・通知を確かめてください",
  "G01.only_after": "コード {code}（{what}）は、持っているマスターのうち、診療年月の後の版にだけあります。診療年月に使えるコードか、告示・通知を確かめてください",
  // G02・G03（段 11）。{later} は、後の版のマスターで点検していて、その行が診療年月の後に変更されているときの断り書き（なければ空）。ここは言い切らない文（言い切りの文は GENERIC_TEXT_CERTAIN）
  "G02.points": "この単位の 1 回分の点数が、マスターからの再計算と合いません（UKE は {uke} 点、再計算は {calc} 点。{formula}）。コード・数量・点数を確かめてください{later}",
  "G03.inpatient_only": "コード {code}（{name}）は、マスターでは入院のレセプトに限るコードです。入院外のレセプトで算定できるか、告示・通知を確かめてください{later}",
  "G03.hospital_only": "コード {code}（{name}）は、マスターでは病院に限るコードです。診療所で算定できるか、告示・通知を確かめてください{later}",
  "G03.clinic_only": "コード {code}（{name}）は、マスターでは診療所に限るコードです。病院で算定できるか、告示・通知を確かめてください{later}",
  "G03.age": "コード {code}（{name}）は、マスターの年齢の範囲（{range}）の外です（{when}の年齢は {ages} 歳）。生年月日とコードを確かめてください{later}",
  // G07・G08（段 13）。{comment} は、コメントマスターの名称（定型文）とコメントコード。{sheet}{kouban} は、記載要領の表と項番。G08 は言い切りに上げない（言い切りの文を持たない）
  "G07.missing": "摘要欄に{comment}の記載が見当たりません。コード {code} を算定するときに要る記載として、コメント関連テーブルに載っています（記載要領 {sheet} 項番 {kouban}）。記載要領を確かめてください",
  "G07.missing_any": "摘要欄に、次のどれかの記載が要りますが、どれも見当たりません：{comment}。コード {code} を算定するときに要る記載として、コメント関連テーブルに載っています（記載要領 {sheet} 項番 {kouban}）{when}。記載要領を確かめてください",
  // 記載の形（design.md §17-3）。{comment} はコメントの定型文とコード、{text} は文字データ（半角に寄せたもの）、{form} は形の説明
  "G07.form": "摘要欄の{comment}の文字データ「{text}」が、コメントの形（{form}）に合っていないようです。記載を確かめてください",
  "G07.form_day00": "摘要欄の{comment}の年月日「{text}」の日が 00 です。年月だけを書くコードでなければ、日を書いてください",
  "G07.form_future": "摘要欄の{comment}の年月日「{text}」が、診療年月より後の日付です。予定の日を書く記載でなければ、日付を確かめてください",
  "G08.no_target": "コード {code}（{name}）は、対象の傷病名が要る項目ですが、傷病名マスターで{what}の対象とされている傷病名が、このレセプトの傷病名に見当たりません。傷病名と、告示（特掲診療料の施設基準等の別表）を確かめてください",
  // G09（段 14）。言い切りの文を持たない（公開元が、コンピュータチェックは一律に適用するものではないと断っている）。医学的な助言の形にしない：「見当たりません。確かめてください」まで。
  // {diseases} は、表の傷病名の先頭のいくつか（傷病名マスターの名称とコード）と残りの数。{found} は、疑い病名としてだけあった、表の傷病名
  "G09.iy_no_disease": "コード {code}（{name}）：レセプトの傷病名に、審査支払機関のチェック用の表にある傷病名が見当たりません（表の傷病名は {count} 件：{diseases}）。傷病名のもれか、表にない使い方かを確かめてください",
  "G09.si_no_disease": "コード {code}（{name}）：レセプトの傷病名に、審査支払機関のチェック用の表にある傷病名が見当たりません（表の傷病名は {count} 件：{diseases}）。傷病名のもれか、表にない場合の算定かを確かめてください",
  "G09.si_suspected": "コード {code}（{name}）：審査支払機関のチェック用の表にある傷病名が、レセプトには疑い病名としてだけあります（{found}）。表は、この項目には確定病名を対象にしています（表の傷病名は {count} 件）。傷病名の記載を確かめてください",
  // G10（段 17e。design.md §15-5）。{kijun} は施設基準の名称（表 4）とコード、{reason} は申告の三値の理由、{side} は同じ区分番号で申告を満たす行（L-91。ちょうど 1 行のときだけ）。
  // 「問題なし」とは言わない（FR-190）。言い切りの文を持たない（L-101）
  "G10.not_held": "{name}（コード {code}）は、施設基準{kijun}が要ります。施設の申告では{reason}です（施設の申告による）{side}{later}",
  "G10.unknown": "{name}（コード {code}）に要る施設基準{kijun}の申告が{reason}ので、算定できるかは言えません。施設の申告で入れてください（施設の申告による）{later}",
  "G09.heiyo_kinki": "コード {a}（{nameA}）と {b}（{nameB}）は、審査支払機関の併用のチェック用の表にある組で、同じ日（{days}日）に両方あります。併用禁忌・併用注意などのどれに当たる組かは、表からは分かりません。処方の内容を確かめてください",
};
/** 言い切り（確定）に上げた指摘は、言い切りの文（GENERIC_TEXT_CERTAIN）があればそれを使う。ほかは、言い切らない文 */
export const genericText = (f: Pick<GenericFinding, "messageKey" | "params"> & { certainty?: GenericFinding["certainty"] }): string =>
  ((f.certainty === "確定" ? GENERIC_TEXT_CERTAIN[f.messageKey] : undefined) ?? GENERIC_TEXT[f.messageKey] ?? TABLE_TEXT[f.messageKey] ?? f.messageKey).replace(/\{(\w+)\}/g, (_, k: string) => f.params[k] ?? "");

/**
 * 段 12（G04 包括・G05 背反・G06 算定回数。design.md §12-3）の指摘の文。ここは言い切らない文（条件つきで出すときの文）。
 * 値：{parent}{child}{a}{b}{code} はコード、{days}{dayA}{dayB} は日、{keep} は表で算定する側（コードか「いずれか一方」）、{limit}{count} は回数。
 * _cond は、表の特例条件が「条件あり」の行（条件の中身はデータにない）
 */
const TABLE_TEXT: Record<string, string> = {
  "G04.day": "コード {child} は、同じ日の {parent} に含まれる項目として電子点数表に載っていて、同じ日（{days}日）に両方あります。別に算定できるか、告示・通知を確かめてください",
  "G04.day_cond": "コード {child} は、条件によっては、同じ日の {parent} に含まれます（条件の中身はデータにありません）。同じ日（{days}日）に両方あります。告示・通知を確かめてください",
  "G04.month": "コード {child} は、同じ月の {parent} に含まれる項目として電子点数表に載っていて、同じレセプトに両方あります。別に算定できるか、告示・通知を確かめてください",
  "G04.month_cond": "コード {child} は、条件によっては、同じ月の {parent} に含まれます（条件の中身はデータにありません）。同じレセプトに両方あります。告示・通知を確かめてください",
  "G04.same": "コード {child} は、{parent} と同時に行うと {parent} に含まれる項目として電子点数表に載っています。同じ日（{days}日）に両方あります。同時に行ったものかを確かめてください",
  "G04.same_cond": "コード {child} は、{parent} と同時に行うと、条件によっては {parent} に含まれます（条件の中身はデータにありません）。同じ日（{days}日）に両方あります。同時に行ったものかと、告示・通知を確かめてください",
  "G04.surgery": "コード {child} は、{parent} と同じ手術で行うと {parent} に含まれる項目として電子点数表に載っています。同じ日（{days}日）に両方あります。同じ手術で行ったものかを確かめてください",
  "G04.surgery_cond": "コード {child} は、{parent} と同じ手術で行うと、条件によっては {parent} に含まれます（条件の中身はデータにありません）。同じ日（{days}日）に両方あります。同じ手術で行ったものかと、告示・通知を確かめてください",
  "G05.day": "コード {a} と {b} は、同じ日に併せて算定できない組として電子点数表に載っていて、同じ日（{days}日）に両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.day_cond": "コード {a} と {b} は、条件によっては、同じ日に併せて算定できません（条件の中身はデータにありません）。同じ日（{days}日）に両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.month": "コード {a} と {b} は、同じ月に併せて算定できない組として電子点数表に載っていて、同じレセプトに両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.month_cond": "コード {a} と {b} は、条件によっては、同じ月に併せて算定できません（条件の中身はデータにありません）。同じレセプトに両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.same_unit": "コード {a} と {b} は、同時に併せて算定できない組として電子点数表に載っていて、同じ算定単位に両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.same_unit_cond": "コード {a} と {b} は、条件によっては、同時に併せて算定できません（条件の中身はデータにありません）。同じ算定単位に両方あります（表で算定する側：{keep}）。告示・通知を確かめてください",
  "G05.same_day": "コード {a} と {b} は、同時に行うと併せて算定できない組として電子点数表に載っています（表で算定する側：{keep}）。別の算定単位ですが、同じ日（{days}日）に両方あります。同時に行ったものかを確かめてください",
  "G05.same_day_cond": "コード {a} と {b} は、同時に行うと、条件によっては併せて算定できません（条件の中身はデータにありません。表で算定する側：{keep}）。別の算定単位ですが、同じ日（{days}日）に両方あります。同時に行ったものかと、告示・通知を確かめてください",
  "G05.week": "コード {a} と {b} は、1 週間のうちに併せて算定できない組として電子点数表に載っています（表で算定する側：{keep}）。7 日以内（{dayA}日と{dayB}日）に両方あります。1 週間の数え方（起算日から 7 日か、暦の週か）は項目ごとに違うので、告示・通知を確かめてください",
  "G05.week_cond": "コード {a} と {b} は、条件によっては、1 週間のうちに併せて算定できません（条件の中身はデータにありません。表で算定する側：{keep}）。7 日以内（{dayA}日と{dayB}日）に両方あります。告示・通知を確かめてください",
  // 背反の特例条件の例外（design.md §13-2。EM §2-12）。{where} は「同じ日（3日）」「同じレセプト」など、{hxText} は例外の一言、{hx}・{hp} は EM の例外・組の id
  "G05.exception_needs_check": "コード {a} と {b} は、告示・通知の例外〔{hxText}〕に当たれば併せて算定できます（{where}）。例外に当たるには次の要件が要るので、確かめてください：{checks}（{hx}）",
  "G05.exception_needs_comment": "コード {a} と {b} は、告示・通知の例外〔{hxText}〕に当たる場合は、摘要欄に {comments} の記載が要ります。例外に当たる日が {need} 日あり、記載は {have} 件です（{hx}）",
  "G05.exception_none": "コード {a} と {b} は、併せて算定できない組です（{where}。表で算定する側：{keep}）。{because}告示・通知の例外〔{hxText}〕に当たりません。この組の例外の一覧がそろっているかは確かめ終えていないので、告示・通知を確かめてください（{hp}）",
  "G05.exception_ask": "コード {a} と {b} は、条件によっては併せて算定できません（{where}。表で算定する側：{keep}）。告示・通知の例外〔{hxText}〕に当たれば併せて算定できるので、下の問いに答えてください（{hp}）",
  "G05.exception_check": "コード {a} と {b} は、条件によっては併せて算定できません（{where}。表で算定する側：{keep}）。告示・通知の例外〔{hxText}〕に当たれば併せて算定できます。{questions}（{hp}）",
  // 院内の知識（承認済み・avoid）を添えた背反（design.md §14-3。Lv.5 以上の本人）
  "G05.local_avoid": "コード {a} と {b} は、院内の知識（承認済み）で、併せて算定できない組です（{where}。表で算定する側：{keep}）。{localNote}（{localIds}）",
  "G05.exception_split": "コード {a} と {b} は、条件によっては併せて算定できません（{where}。表で算定する側：{keep}）。告示・通知の例外〔{hxText}〕に当たるかが日によって分かれています（当たる日：{hitDays}日、当たらない日：{missDays}日）。告示・通知を確かめてください（{hp}）",
  "G06.day": "コード {code} は、1 日に {limit} 回までとして電子点数表に載っていますが、{days}日に、それを超える回数があります（多い日で {count} 回）。告示・通知を確かめてください",
  "G06.day_cond": "コード {code} は、条件によっては、1 日に {limit} 回までです（条件の中身はデータにありません）。{days}日に、それを超える回数があります（多い日で {count} 回）。告示・通知を確かめてください",
  "G06.month": "コード {code} は、1 月に {limit} 回までとして電子点数表に載っていますが、このレセプトに {count} 回あります。告示・通知を確かめてください",
  "G06.month_cond": "コード {code} は、条件によっては、1 月に {limit} 回までです（条件の中身はデータにありません）。このレセプトに {count} 回あります。告示・通知を確かめてください",
  "G06.week": "コード {code} は、1 週間に {limit} 回までとして電子点数表に載っていますが、日曜から土曜の 1 週間（{days}日）に {count} 回あります。1 週間の数え方（起算日から 7 日か、暦の週か）は項目ごとに違うので、告示・通知を確かめてください",
  "G06.week_cond": "コード {code} は、条件によっては、1 週間に {limit} 回までです（条件の中身はデータにありません）。日曜から土曜の 1 週間（{days}日）に {count} 回あります。告示・通知を確かめてください",
  "G06.master_limit": "コード {code} は、医科診療行為マスターの上限回数が {limit} 回ですが、このレセプトに {count} 回あります。上限回数の単位（月か、ほかの期間か）はマスターの仕様に書かれていないので、告示・通知を確かめてください",
};

/** 言い切りの文。言い切りの候補（特例条件がなく、単位が日・月・同じ算定単位）の種類だけ。出るのは、config/generic-checks.json の certain に載せた種類に限る（2026-11-21 に 4 種類：G03.inpatient_only・G03.clinic_only・G05.same_unit・G06.day） */
export const GENERIC_TEXT_CERTAIN: Record<string, string> = {
  "G04.day": "コード {child} は、同じ日の {parent} に含まれるので、別に算定できません。同じ日（{days}日）に両方あります",
  "G04.month": "コード {child} は、同じ月の {parent} に含まれるので、別に算定できません。同じレセプトに両方あります",
  "G05.day": "コード {a} と {b} は、同じ日に併せて算定できません。同じ日（{days}日）に両方あります（算定する側：{keep}）",
  "G05.month": "コード {a} と {b} は、同じ月に併せて算定できません。同じレセプトに両方あります（算定する側：{keep}）",
  "G05.same_unit": "コード {a} と {b} は、同時に併せて算定できません。同じ算定単位に両方あります（算定する側：{keep}）",
  // 背反の特例の例外に当たらないと確かめた組（config/generic-checks.json の certain に G05.exception_none#HP-nn を載せた組だけ。design.md §13-4）
  "G05.exception_none": "コード {a} と {b} は、併せて算定できません（{where}。算定する側：{keep}）。{because}告示・通知の例外〔{hxText}〕に当たりません（{hp}）",
  "G06.day": "コード {code} は、1 日に {limit} 回までです。{days}日に上限を超えています（多い日で {count} 回）",
  "G06.month": "コード {code} は、1 月に {limit} 回までです。このレセプトに {count} 回あり、上限を超えています",
  // 段 11（G02・G03）。後の版のマスターで点検していて、その行が診療年月の後に変更されているときは、点検が条件つきにするので、ここの文にはならない
  "G02.points": "この単位の 1 回分の点数が、マスターからの再計算と合っていません（UKE は {uke} 点、再計算は {calc} 点。{formula}）",
  "G03.inpatient_only": "コード {code}（{name}）は、入院のレセプトに限るコードです。入院外のレセプトでは算定できません",
  "G03.hospital_only": "コード {code}（{name}）は、病院に限るコードです。診療所では算定できません",
  "G03.clinic_only": "コード {code}（{name}）は、診療所に限るコードです。病院では算定できません",
  "G03.age": "コード {code}（{name}）は、年齢の範囲（{range}）の外なので算定できません（{when}の年齢は {ages} 歳）",
  // 段 13（G07）
  "G07.missing": "摘要欄に{comment}の記載がありません。コード {code} を算定するときは、必ず要る記載です（記載要領 {sheet} 項番 {kouban}）",
  "G07.missing_any": "摘要欄に、次のどれかの記載が要りますが、どれもありません：{comment}（コード {code}。記載要領 {sheet} 項番 {kouban}）",
  "G07.form": "摘要欄の{comment}の文字データ「{text}」が、コメントの形（{form}）に合っていません",
};

/** G04〜G06 が点検していないこと（点検の範囲の説明に、その点検が動いたときに出す。design.md §12-3） */
export const GENERIC_SCOPE_NOTE: Record<string, string> = {
  G04: "包括の単位が「手術前 1 週間」の組と、補助マスターの 2 つ目・3 つ目のグループは、点検していません。「同時」「1 手術につき」の組は、同じ日にあるものだけを条件つきで出します",
  G05: "「同時」の組は、同じ算定単位か同じ日にあるものだけを見ています。「1 週間につき」の組は、このレセプトの月の中だけで見ています（前後の月にまたがる分は点検していません）",
  G06: "日・月・週の上限だけを点検しています。2 月以上の期間、一連・入院中・患者当りなど、レセプト 1 枚から数えられない単位の上限は、点検していません",
};

/** 動かさなかった点検の理由の文（「問題なし」と区別して出す。design.md §12-1） */
export function genericNotRunText(n: Pick<GenericNotRun, "reason" | "detail">): string {
  switch (n.reason) {
    case "noMasters":
      return "マスターが入っていないので、していません";
    case "notReady":
      return `準備ができていないので、していません${n.detail ? `（${n.detail}）` : ""}`;
    case "noSnapshot":
      return `${n.detail}。この点検はしていません`;
    case "notBuilt":
      return "この点検は、まだ入っていません";
  }
}

/**
 * 摘要欄の記載の点検（R17）の範囲（design.md §11-13）。checked は点検している項目（版の表＝EM §2-10 表 1 の行と同じ並び）、
 * uncheckedCount は、別表Ⅰ に定めがあるが点検していない項目の数（EM §2-10 表 2 の行数）。どちらも tests/engine/comments.test.ts が表と突き合わせる
 */
export const COMMENT_CHECK_SCOPE = {
  checked: [
    "管理料の月の、往診・訪問診療の年月日",
    "包括的支援加算の状態",
    "在宅移行早期加算の、初回の管理料の算定日",
    "在宅ターミナルケア加算の死亡年月日",
    "在宅以外で亡くなったときの、死亡前 24 時間以内の訪問診療の日時",
    "在宅酸素療法指導管理料の、動脈血酸素分圧又は飽和度",
    "訪問診療と同じ日の往診の理由",
    "急性増悪で週 4 回以上訪問したときの、必要性と日付",
    "単一建物 2 人以上の区分の管理料の、単一建物診療患者の人数",
  ],
  uncheckedCount: 18,
};
/** 画面の点検の説明に出す文 */
export const COMMENT_CHECK_NOTE = `摘要欄の必須の記載のうち、点検しているのは次の ${COMMENT_CHECK_SCOPE.checked.length} 項目です：${COMMENT_CHECK_SCOPE.checked.join("／")}。記載要領の別表Ⅰ に定めがあっても、点検していない項目が ${COMMENT_CHECK_SCOPE.uncheckedCount} 件あります。`;

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
  disabilitySupportLevel: "障害支援区分",
  table8_3Other: "要介護度と障害支援区分のほかに、別表第八の三の状態（認知症の日常生活自立度Ⅲ以上、週1回以上の訪問看護、処置、麻薬の投薬など）に当たるか",
  mainDisease: "主病",
  homeOxygen: "在宅酸素療法中か",
  deathPlace: "看取りの場所",
  visitsComplete: "訪問の記録がそろっているか",
  acuteExacerbation: "急性増悪か",
  emergencyEligible: "緊急往診の対象患者か",
  residence: "居住の場所（居宅か、施設に入居しているか）",
  contactDocProvided: "連絡担当者・往診担当医などの文書を患者に提供しているか",
  sameDaySeparate: "同じ日の訪問診療と往診が、別々の診療か（1 回の診療ではないか）",
  sameDayOushinAfterVisit: "その日、訪問診療のあとに、病状の急変などで往診したか",
  dischargeJointGuidance: "退院時共同指導料1 を算定したか",
  rxLongPsychotropic: "その日の処方が、不安・不眠の薬の 1 年以上の継続処方に当たるか",
  rapidSameDayDocumented: "検査の結果を当日中に説明し、文書で提供した記録があるか",
  comprehensiveCare: "管理料（在医総管・施設総管）を算定する患者か",
  buildingBand: "単一建物診療患者の人数の区分（みなしを当てたあとの、請求に使う区分）",
  residenceType: "住まいの種別（自宅・有料老人ホーム・サ高住・特養・老健など）",
  terminalCancer: "末期の悪性腫瘍か",
  careLevelMixed: "月の途中で要介護度が変わったか",
};

/** 足りない施設の設定の名前（施設の設定で確かめるよう案内する。design.md §6-1） */
export const FACILITY_LABEL: Record<FacilityFactKey, string> = {
  grade: "施設の種別（在宅療養支援診療所の区分）",
  dxTier: "在宅医療DX情報活用加算の届出の区分",
  baseUp: "ベースアップ評価料の届出の区分",
  priceResponse: "物価対応料を算定するか",
  note16Met: "管理料の注16 の基準を満たしているか",
  building: "同じ建物で同じ月に 2 人以上を診ている建物があるか",
  note14: "注14（単一建物 10 人以上の区分の減算）の点数で算定しているか",
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
  D04: "管理料が月 2 回以上（重症以外）か月 1 回の区分で、要介護 3 以上・障害支援区分 2 以上など別表第八の三の状態",
  D05: "退院後に在宅療養を始め、管理料の算定開始月から 3 か月目まで",
  D06: "訪問診療料を算定した月に 1 回（届出の区分による）",
  D07: "訪問診療料の日は訪問診療時の区分、往診料だけの日は再診時等の区分",
  D08: "訪問診療料の日は訪問診療時の区分、往診料だけの日は再診時等の区分",
  D09: "検査の項目ごとに 1 回。血液採取は検査の日ごとに 1 回、判断料は区分ごとに月 1 回",
  D10: "管理料を算定しない月の処方。内服の種類数と、向精神薬の長期処方かで区分が決まる",
  D11: "本人が選んだ",
  D12: "本人が選んだ（死亡日前 14 日以内に 2 回以上の訪問・往診の記録があるか、退院時共同指導料1 を算定して訪問診療の記録がある）",
};

/** 確認してほしい点の文。情報不足は「どこを確かめるか」を添える（医療事務あては本人、医師あては医師確認） */
export function findingText(f: Finding): string {
  if (f.kind === "情報不足" && f.missing) {
    const facilityKey = f.missing.field.startsWith("facility.") ? (f.missing.field.slice("facility.".length) as FacilityFactKey) : null;
    const declared = facilityKey !== null && DECLARED_FACILITY_KEYS.includes(facilityKey);
    // 文を持つ情報不足（申告と請求の食い違い。design.md §15-4）
    if (!f.messageKey.endsWith(".missing_fact") && FINDING_TEXT[f.messageKey]) return `${FINDING_TEXT[f.messageKey]}${declared ? `。${DECLARATION_GUIDE}` : ""}${BY_DECLARATION.has(f.messageKey) ? BY_DECLARATION_NOTE : ""}`;
    if (declared) return `施設の申告「${FACILITY_LABEL[facilityKey]}」が分かりません（申告がない・確かめ直す日を過ぎたなど）。${DECLARATION_GUIDE}`;
    if (facilityKey !== null) {
      const label = FACILITY_LABEL[facilityKey] ?? f.missing.field;
      return `施設の設定「${label}」が入っていません。事務長か責任者に確かめて、施設の設定に入力してください`;
    }
    // 単一建物の人数：施設の申告（building）も分からないときは、施設の申告の画面への案内を先に出す（1 項目で全患者が決まりうるため。design.md §15-4）
    if (f.missing.field === "buildingBand")
      return `${f.params?.facilityFirst ? `施設の申告「${FACILITY_LABEL.building}」が分かりません。${DECLARATION_GUIDE}。「ない」と申告すれば、患者ごとには入れなくて済みます。そうでなければ、` : ""}${FACT_LABEL.buildingBand}が入っていません。${BUILDING_BAND_GUIDE}`;
    const day = f.missing.date ? `（${Number(f.missing.date.slice(5, 7))}月${Number(f.missing.date.slice(8, 10))}日）` : "";
    // カルテ側の記録がない請求：入力を求めない（記録を足す手段がこの請求にはない。design.md §11-6）
    if (f.missing.field === "chartRecord") return "この請求にはカルテ側の記録がありません。訪問・処方・退院などの記録で決まる点は確かめていません";
    // 点検の対象外の行がある請求：ほかの行の有無や回数で決まる点は決められない（design.md §11-11）
    if (f.missing.field === "unsupportedLines") return "この請求には点検の対象外の行があるため、決められません";
    // 処方の記録と対応がとれない行：区分誤りとも正しいとも言えない（design.md §11-5）
    if (f.missing.field === "rxRecord") return `処方箋料の行${day}に当たる処方の記録が、1 件に決まりません。その日の処方の記録を確かめてください`;
    const label = FACT_LABEL[f.missing.field as FactKey] ?? f.missing.field;
    return f.missing.target === "doctor"
      ? `${label}${day}がカルテから分かりません。医師確認で確かめましょう`
      : `${label}${day}が入っていません。${f.missing.field === "careLevel" ? "介護保険証で" : f.missing.field === "disabilitySupportLevel" ? "受給者証で" : ""}確かめて入力してください`;
  }
  const text = (FINDING_TEXT[f.messageKey] ?? f.messageKey).replace(/\{(\w+)\}/g, (_, k: string) => f.params?.[k] ?? "") + (BY_DECLARATION.has(f.messageKey) ? BY_DECLARATION_NOTE : "");
  // 日付の食い違い（R17）：足りない日・多い日を添える
  const days = (v: string | undefined) => (v ? v.split(",").map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("、") : "");
  const detail = [f.params?.lacking ? `記載のない日：${days(f.params.lacking)}` : "", f.params?.extra ? `算定のない日：${days(f.params.extra)}` : ""].filter(Boolean).join("。");
  return detail ? `${text}（${detail}）` : text;
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

/**
 * 背反の組の院内の知識（design.md §14-1〜§14-4）の文言。点数・金額の語を入れない。
 * bases は、条件の文の先頭に付ける根拠（定型）。allow と「返戻・査定された」の組は作れない
 */
export const LOCAL_PAIR_BASES = ["審査で通った", "返戻・査定された", "疑義照会の答え", "その他"] as const;
export type LocalPairBasis = (typeof LOCAL_PAIR_BASES)[number];
export const LOCAL_PAIR_TEXT = {
  /** Lv.5 以上・承認済みの allow（ボタンを添える） */
  allow: "院内の知識（承認済み）：条件に当たれば併せて算定できます。条件：{note}",
  /** 押すボタン（同一月の表は請求ごと、ほかは日ごと）。1 日目から付くので「も」は付けない */
  press: "この請求は条件に当たる",
  pressDay: "{day}：条件に当たる",
  /** Lv.1〜4 のヒント */
  hintAllow: "院内の知識：条件に当たれば併せて算定できます。条件：{note}（ご自身で確かめ、必要ならベテランに聞いてください）",
  hintAvoid: "院内の知識：併せて算定できません。{note}（ご自身で確かめ、必要ならベテランに聞いてください）",
  avoidNote: "院内の知識：{note}",
  conflict: "院内の知識が食い違っています（承認済みに、併せて算定できるものと、できないものがあります：{ids}）。どちらも使っていません",
  unverified: "前回の確かめ（未検証）があります：{ids}",
  silenced: "院内の知識で、この請求も条件に当たると確かめたので出していない",
  /** 作る入口（取り込んだレセプトの点検の、対象の G05 の指摘の下） */
  create: "この組の扱いを院内の知識として残す",
  createNote: "患者の氏名・番号を書かないでください。条件は文で書き、機械では当てません（請求ごとに、人が条件に当たるかを確かめます）",
  /** 作る入口が断る向きが両方ある組（フォームを出さない） */
  createFull: "この組には、両方の扱いの院内の知識がすでにあります（知識の画面で見られます）",
  allowLabel: "条件に当たれば併せて算定できる",
  avoidLabel: "併せて算定できない",
  /** 条件の文の先頭に付ける根拠 */
  basisPrefix: "根拠：{basis}。",
  /** 返戻の入口 */
  returned: "この請求のこの組が返戻・査定された",
  returnedNote: "押すと、この組の院内の知識（承認済み・条件に当たれば併せて算定できる）を要再検証にし、この請求で押した「条件に当たる」を取り消します",
  /** ローカルルール欄（知識の一覧） */
  emDecided: "EM の決まりがある組です（例外の決まりで決まるので、この知識は使われません）",
  summaryAllow: "背反の組 {a}・{b}（{table}）：条件に当たれば併せて算定できる",
  summaryAvoid: "背反の組 {a}・{b}（{table}）：併せて算定できない",
  /** 押した事実の一覧（請求ごとの事実）での名前。押した人の名前・レベルは出さず、役割だけ */
  pressedFact: "院内の知識 {id} の条件に当たる（コード {a} と {b}）",
  /** 会議の修正版（と承認の画面）に出す、実際に使われる扱いと条件（round-43 codex #3） */
  fixLine: "修正版の扱い：{label}。条件：{note}",
  usedAs: "使われる扱い：{label}。条件：{note}",
  /** 承認済みでないあいだに出た改定の差（承認し直す議題・承認のキュー。design.md §14-4 v28） */
  revisionDiff: "改定で差が出ています：{changes}（改定日 {date}）",
  /** 押した事実の取り消し（round-43 codex #4） */
  unpress: "取り消す",
} as const;
/** 文言の {名前} を値で埋める */
export const fillLocal = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
/** 「条件に当たる」のボタンの文。date は押す日（"YYYY-MM-DD"。同一月の表は null） */
export const pressText = (date: string | null): string =>
  date ? fillLocal(LOCAL_PAIR_TEXT.pressDay, { day: `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` }) : LOCAL_PAIR_TEXT.press;

/** 会議の議題の「きっかけ」に出す、見直しのトリガーの名前（design.md §4-3・§14-4） */
export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  revision: "改定",
  reappointment: "改選",
  idle: "長く使われていない",
  official: "公的文書",
  localRevision: "改定でこの組に差が出た",
  localReturn: "この組の返戻・査定",
};
/** 会議の議題の「きっかけ」に出す、トリガー以外のイベントの名前（要再検証・停止に入ったイベント。design.md §4-2） */
export const EVENT_LABEL: Record<string, string> = {
  COUNTER_EXAMPLE: "外れの確認で「直す必要がある」と答えた",
  RECHECK_FAIL: "確かめ直しで「直す必要がある」と答えた",
  IDLE_EXPIRED: "要再検証のまま長く使われていない",
};
const triggerLabel = (t: string): string => TRIGGER_LABEL[t as TriggerKind] ?? t;
/**
 * 議題の「きっかけ」の文。event は history のイベント名（TRIGGER{idle} などの形）、trigger は根拠に残したトリガー。
 * トリガーのイベントはその名前だけにし、根拠のトリガーが別の名前のときだけ括弧で添える。表にない名前はそのまま出す
 */
export function eventText(event: string, trigger?: string): string {
  const m = /^TRIGGER\{(\w+)\}$/.exec(event);
  const base = m ? triggerLabel(m[1]) : (EVENT_LABEL[event] ?? event);
  const extra = trigger ? triggerLabel(trigger) : "";
  if (base === "") return extra;
  return extra !== "" && extra !== base ? `${base}（${extra}）` : base;
}

/**
 * 導出の保留（事実不足）の文（src/chart/claim.ts）。reason のある保留は、事実がないのではなく決められない理由の文（段 17h）：
 * note14_conflict は R18.note14_conflict と同じ文と、施設の申告の画面への案内（round-58 C-330＝X-181）。declaration_conflict は R19.declaration_conflict と同じ文と同じ案内（round-61 X-200）。note8 は注8 を見ていないので減の行を決められないこと（round-57 X-171）
 */
export function pendingText(p: { need: NeedKey; date?: string; reason?: PendingReason }, md: (d: string) => string): string {
  if (p.reason === "care_family") return "住まいの種別（老健・介護医療院・養護老人ホームなど）・月の途中の住まいの変化・短期入所などで、この月の管理料の族（在医総管か施設総管か）を決めていません（介護保険との調整の点検で見ます）";
  if (p.reason === "note14_conflict") return `${FINDING_TEXT["R18.note14_conflict"]}。${DECLARATION_GUIDE}`;
  if (p.reason === "declaration_conflict") return `${FINDING_TEXT["R19.declaration_conflict"]}。${DECLARATION_GUIDE}`;
  if (p.reason === "note8") return "注8 の減算に当たるかを見ていないので、減の行を 1 つに決められません";
  return `${needLabel(p.need)}${p.date ? `（${md(p.date)}）` : ""}`;
}
