// 介護保険との調整（C）・ほかの医療機関との調整（D）の申告の型と、判定に渡す形（design.md §18-2・§18-3・§18-4）。
// 値は医療事務が確かめた申告だけ。LLM は読まない・作らない。機関名・施設名はエンジンに渡さない（判断 L）
import type { Residence } from "./types";

/** 三値（はい・いいえ・分からない）。印がないことを「いいえ」と読まない（C-512） */
export type Tri = "はい" | "いいえ" | "分からない";
export const TRI: readonly Tri[] = ["はい", "いいえ", "分からない"];

/** 住まいの種別（design.md §18-2 の residenceType） */
export const RESIDENCE_TYPES = [
  "自宅",
  "有料老人ホーム（特定施設の指定なし）",
  "サ高住（特定施設の指定なし）",
  "特定施設（介護付き有料老人ホームなど）",
  "有料・サ高住で特定施設の指定か分からない",
  "GH（認知症対応型共同生活介護）",
  "特養（地域密着型を含む）",
  "養護老人ホーム（定員 110 名以下）",
  "養護老人ホーム（それ以外）",
  "軽費老人ホーム A 型",
  "老健",
  "介護医療院",
  "分からない",
] as const;
export type ResidenceType = (typeof RESIDENCE_TYPES)[number];

/**
 * 住まいの種別 → 判定に渡す 2 値（design.md §18-2。EM R8-252・R8-253・R8-255）。"none" は「2 値に当たらない」（老健・介護医療院は R20 ② が見る。
 * 養護〔それ以外〕は EM に行がないので決めない）。null は分からない
 */
export function residenceOfType(t: ResidenceType): Residence | "none" | null {
  if (t === "自宅") return "居宅";
  if (t === "分からない") return null;
  if (t === "養護老人ホーム（それ以外）" || t === "老健" || t === "介護医療院") return "none";
  return "施設入居等";
}

/** 入所先の施設を付ける種別（施設の種別。自宅・分からないを除く）と、短期入所・宿泊の利用先にも使う種別 */
export const CARE_HOME_KINDS = [...RESIDENCE_TYPES.filter((t) => t !== "自宅" && t !== "分からない"), "小多機・看多機", "病院・診療所"] as const;
export type CareHomeKind = (typeof CARE_HOME_KINDS)[number];

/** 短期入所・宿泊の種類（design.md §18-2 の shortStay） */
export const SHORT_STAY_KINDS = ["短期入所生活介護", "短期入所療養介護（老健）", "短期入所療養介護（病院・診療所）", "小多機・看多機の宿泊"] as const;
export type ShortStayKind = (typeof SHORT_STAY_KINDS)[number];

/** 訪問看護の保険（入れ物だけ。最初の版の場面は読まない。C-514） */
export const NURSE_INSURANCES = ["医療保険", "介護保険", "使っていない", "分からない"] as const;

/** 申告の出どころ（design.md §18-2） */
export const CARE_SOURCES = ["介護保険被保険者証", "ケアマネジャーからの連絡", "施設との契約", "本人・家族", "その他"] as const;
export type CareSource = (typeof CARE_SOURCES)[number];

/** ほかの機関の種別と、在医総管を取る側 */
export const OTHER_KINDS = ["医療機関", "訪問看護ステーション"] as const;
export const KANRI_SIDES = ["当院", "その機関", "分からない", "取っていない"] as const;
/** ほかの機関がしていること（項目ごとに三値。C-512） */
export const OTHER_ACTIVITIES = ["訪問診療", "医療機関が行う訪問看護", "ステーションの訪問看護（医療保険）", "在がん総診", "求めによる訪問診療の求めた側"] as const;
export type OtherActivity = (typeof OTHER_ACTIVITIES)[number];

/** 入所先の施設の値（判定に渡す形。名前は渡さない）。看取り介護加算の値は、確かめ直す日を過ぎていれば「分からない」にしてから渡す（判断 K） */
export type CareHomeFacts = { kind: CareHomeKind; placedPhysician: Tri; mitoriFacility: Tri };

/** 確かめた日と出どころ（前提の文に出す） */
export type Basis = { checkedOn: string; source: CareSource };

/** 短期入所・宿泊の利用 1 つ。priorVisit は、開始日の前日から遡って 30 日に当院の訪問診療料等の算定があったか（当院の請求から導く。X-360。分からないは null） */
export type ShortStayUse = { kind: ShortStayKind; start: string | null; end: string | null; home: CareHomeFacts | null; fromDischarge: Tri; priorVisit: boolean | null };

/**
 * 請求の文脈に足す介護の申告（診療年月に効く申告から作る。design.md §18-3）。項目がないのは申告がない。
 * certified は要介護・要支援の認定があるか（careCert から。§18-1）
 */
export type CareFacts = {
  residence?: { type: ResidenceType; changedMidMonth: boolean; home: CareHomeFacts | null } & Basis;
  shortStay?: { status: "使った" | "使っていない" | "分からない"; uses: ShortStayUse[]; derived?: true } & Partial<Basis>;
  certified?: { known: true; value: boolean; checkedOn: string; source: string } | { known: false };
};

/** ほかの機関の行（判定に渡す形。機関名は渡さない） */
export type OtherRow = { kind: (typeof OTHER_KINDS)[number]; specialRelation: Tri; kanriSide: (typeof KANRI_SIDES)[number]; activities: Partial<Record<OtherActivity, Tri>>; referredOn: string | null } & Basis;
/** 請求の文脈に足す ほかの機関の申告（design.md §18-4）。none は「ほかの機関はないと確かめた」が効いている */
export type OtherFacts = { rows: OtherRow[]; none: Basis | null };
