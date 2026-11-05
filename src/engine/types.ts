// ルールエンジンの入出力の型（design.md §2-1・§2-2）

/** 三値の事実。known=false は「わからない」（C-4） */
export type Fact<T> = { known: true; value: T } | { known: false };

export type Payer = "支払基金" | "国保連";

export type Facility = {
  /** 在宅療養支援診療所か */
  zaishishin: boolean;
  /** 機能強化型か */
  kyokagata: boolean;
  hasBeds: boolean;
  prefecture: string;
  /** 届出の有無（区分番号→届出済みか） */
  notifications: Record<string, boolean>;
};

export type Facts = {
  age: Fact<number>;
  /** 保険種別（例: "後期高齢者", "国保"） */
  insurance: Fact<string>;
  burdenRatio: Fact<number>;
  /** 要介護度（要介護 1〜5。要支援・非該当は 0） */
  careLevel: Fact<number>;
  /** 別表第七に該当 */
  table7: Fact<boolean>;
  /** 別表第八の二に該当（重症区分） */
  table8_2: Fact<boolean>;
  mainDisease: Fact<string>;
  homeOxygen: Fact<boolean>;
  /** 看取りの場所（"在宅" など。死亡がない月は null） */
  deathPlace: Fact<string | null>;
  /** 訪問・往診の記録が月全体で揃っているか */
  visitsComplete: Fact<boolean>;
  /** 急性増悪で頻回の訪問が必要と医師が判断したか */
  acuteExacerbation: Fact<boolean>;
  /** 緊急往診加算の対象患者か（自院で訪問診療中の患者等） */
  emergencyEligible: Fact<boolean>;
};

export type FactKey = keyof Facts;

export type ClaimEvent =
  | { type: "visit"; date: string; sameBuildingCount: number }
  | { type: "oushin"; date: string; kind: "normal" | "emergency" }
  | { type: "test"; date: string; items: string[] }
  | { type: "prescription"; date: string; oralKinds: number; days: number }
  | { type: "death"; date: string }
  | { type: "discharge"; date: string }
  /** 在医総管の算定開始月（"YYYY-MM"） */
  | { type: "kanriStart"; month: string };

export type ClaimLine = { kubun: string; count: number; dates: string[] };

export type ClaimContext = {
  claimId: string;
  yearMonth: string;
  facility: Facility;
  payer: Payer;
  prefecture: string;
  facts: Facts;
  events: ClaimEvent[];
  lines: ClaimLine[];
  /** 摘要コメント（UKE の CO レコードから F4 が作る。コードは架空）。載っていないものは「なかった」 */
  comments?: { kubun: string; code: string }[];
  /** 過去月の算定（設定ファイルの固定値。spec 決定62）。載っていない月は「算定なし」 */
  history?: { yearMonth: string; kubun: string[] }[];
};

export type FindingKind = "不一致" | "背反" | "取り忘れ" | "区分誤り" | "要件不足" | "情報不足";

export type Finding = {
  ruleId: string;
  kind: FindingKind;
  lineRefs: string[];
  missing?: { target: "doctor" | "clerk"; field: string };
  messageKey: string;
  reference: string;
};

export type EngineResult = {
  claimId: string;
  total: number | null;
  byLine: { kubun: string; points: number | null }[];
  findings: Finding[];
  /** appliesTo が真だったルール ID（違反の有無によらない。X-3） */
  applied: string[];
};

export type Rule = {
  id: string;
  /** 対象区分（§4-4 で「関係あり」の判定に使う。C-6） */
  kubun: string[];
  reference: string;
  appliesTo(ctx: ClaimContext): boolean;
  /** 判定に必要な事実。known=false があれば check を呼ばず「情報不足」 */
  needs(ctx: ClaimContext): FactKey[];
  check(ctx: ClaimContext): Finding[];
};
