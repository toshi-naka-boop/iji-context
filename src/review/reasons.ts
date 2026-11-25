// 査定・返戻の突き合わせ（spec FR-202 の I-1。design/iji-context/plan-i1.md）で人が選ぶ一覧。測る前に固定する（あとから足さない。変えるときは別の回として数える）。
// 結果と理由は人が選ぶ。事由の記号から理由を自動で決めない。AI に分けさせない

/** 結果：その査定・返戻の論点を、レセメンが事前に指摘していたか */
export const RESULTS = ["同じ論点で指摘していた", "別の論点で指摘していた", "指摘なし"] as const;
export type ReviewResult = (typeof RESULTS)[number];

/**
 * 指摘しなかった理由（結果が「別の論点で指摘していた」「指摘なし」のとき）。並びが優先順：複数当たるときは、上にあるものを選ぶ。
 * 上ほど、レセメンの側で直しようのないもの（医学的な判断は規則にできない／データがなければ規則があっても動かない／人に聞く事実がなければ決められない）。
 * 「決まりを作っていない」と「決まりはあるのに当たらなかった」は、レセメンの側で直せるもの
 */
export const MISS_REASONS = [
  "審査の医学的な判断（規則にできない）",
  "データがない（カルテ・構造化データ・患者の情報）",
  "人に聞く事実がない",
  "決まりを作っていない",
  "決まりはあるのに当たらなかった",
  "その他",
  "判定不能",
] as const;
export type MissReason = (typeof MISS_REASONS)[number];

/** 指摘の確からしさ（同じ論点で指摘していたときに数え分ける）。患者情報の指摘（P 系）はユスティの指摘と別に数える */
export const CERTAINTIES = ["確定", "条件つき", "患者情報"] as const;
export type Certainty = (typeof CERTAINTIES)[number];

/** 対象外（分母から外し、報告に別に書く）。自動で決まるもの */
export const AUTO_EXCLUSIONS = ["紙で請求した分", "版がない（2026年6月診療分より前など）", "点検できないレセプト", "当てられない"] as const;
/** 対象外のうち、人が印を付けるもの（記録の形からは分からない） */
export const HUMAN_EXCLUSIONS = ["突合点検", "保険者の再審査による後日の査定", "再審査で戻った（復活）"] as const;
export type HumanExclusion = (typeof HUMAN_EXCLUSIONS)[number];

/** 行への当て方で、名称から 1 つに決まらないときに人が選べる、コード以外の選択肢 */
export const LINE_OTHERS = ["その他", "判定不能"] as const;

/** 増減点の事由の記号（資料1 別表6。sources/research/zogen-henrei-format.md §5）。記録して件数を数えるだけ */
export const JIYU: Record<string, string> = {
  A: "医学的に保険診療上適応とならない",
  B: "医学的に保険診療上過剰・重複",
  C: "A・B 以外で医学的に保険診療上適当でない",
  D: "告示・通知の算定要件に合致していない",
  F: "固定点数誤り",
  G: "請求点数誤り",
  H: "縦計計算誤り",
  K: "その他",
};
/** 請求単位で扱う事由（行に当てない） */
export const CLAIM_LEVEL_JIYU = new Set(["F", "G", "H"]);
