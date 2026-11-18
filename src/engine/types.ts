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
  /** 在宅医療DX情報活用加算の届出区分 */
  dxTier: Fact<"1" | "2" | "なし">;
  /** 外来・在宅ベースアップ評価料(Ⅰ)の届出区分 */
  baseUp: Fact<"通常" | "注5" | "なし">;
  /** 物価対応料を算定するか */
  priceResponse: Fact<boolean>;
  /** 管理料の注16 の基準を満たすか（施設に 1 つ。在医総管と施設総管の両方に効く） */
  note16Met: Fact<boolean>;
  /** 訪問診療料と往診料の両方を算定した日に、ベースアップ評価料(Ⅰ)の「再診時等」を重ねて算定できると確かめたか（R08 だけが読む） */
  revisitBaseUpSameDay: Fact<boolean>;
  /** 同じことを物価対応料について確かめたか（R15 だけが読む） */
  revisitPriceSameDay: Fact<boolean>;
};

/** 三値で持つ施設の設定のキー（不明なら、それに依存するルールは情報不足になる。design.md §2-7） */
export type FacilityFactKey = "dxTier" | "baseUp" | "priceResponse" | "note16Met" | "revisitBaseUpSameDay" | "revisitPriceSameDay";

/** 患者の居住の場所。管理料の族（在医総管／施設総管）を決める */
export type Residence = "居宅" | "施設入居等";

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
  /**
   * 要介護度のほかに、別表第八の三（包括的支援加算の対象）のどれかの状態に当たるか。R03・D04 が読む。
   * 障害支援区分 2 以上、認知症高齢者の日常生活自立度 Ⅲ 以上、週 1 回以上の訪問看護、訪問診療・訪問看護での処置、
   * 看護職員が配置された施設での処置、麻薬の投薬、その他（EM R8-15a）。要介護 3 以上は careLevel で見る
   */
  table8_3Other: Fact<boolean>;
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
  /** 居住の場所（R16）。医療事務が確かめる */
  residence: Fact<Residence>;
  /** 24 時間対応の体制の連絡担当者・往診担当医などを、文書でその患者に提供しているか（R10） */
  contactDocProvided: Fact<boolean>;
  /** 同じ日に訪問診療料と往診料の両方を算定した日ごとに、別々の診療かを確かめた答え（日付 → 真偽）。載っていない日は不明（R10） */
  sameDaySeparate: Fact<Record<string, boolean>>;
  /** 外来迅速検体検査加算について、当日中に結果を説明し文書で提供した記録があるか（R11） */
  rapidSameDayDocumented: Fact<boolean>;
  /** 管理料（在医総管・施設総管）を算定する患者か（計画的な医学管理を行っているか）。導出の D03 だけが読む。医療事務が確かめる（design.md §2-8・L-17） */
  comprehensiveCare: Fact<boolean>;
};

export type FactKey = keyof Facts;
/** ルールが要る入力：患者の事実か、施設の設定（"facility.<key>"） */
export type NeedKey = FactKey | `facility.${FacilityFactKey}`;

export type ClaimEvent =
  | { type: "visit"; date: string; sameBuildingCount: number }
  | { type: "oushin"; date: string; kind: "normal" | "emergency" }
  | { type: "test"; date: string; items: string[] }
  | { type: "prescription"; date: string; oralKinds: number; days: number }
  | { type: "death"; date: string }
  | { type: "discharge"; date: string }
  /** 管理料（在医総管・施設総管）の算定開始月（"YYYY-MM"） */
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
  /** 連携で読んだ行のうち、架空コードの表に対応がなかったもの。判定の対象外（FR-111） */
  excluded?: { code: string; count: number }[];
};

export type FindingKind = "不一致" | "背反" | "取り忘れ" | "区分誤り" | "要件不足" | "情報不足";

export type Finding = {
  ruleId: string;
  kind: FindingKind;
  lineRefs: string[];
  /** 情報不足のとき。施設の設定は field が "facility.<key>"。date は日付ごとの事実（sameDaySeparate）の対象の日 */
  missing?: { target: "doctor" | "clerk"; field: string; date?: string };
  messageKey: string;
  reference: string;
};

export type EngineResult = {
  claimId: string;
  /** 判定に使った版 */
  revisionId: string;
  /** 点数未収載の行、または判定の対象外の行（excluded）があれば null */
  total: number | null;
  byLine: { kubun: string; points: number | null }[];
  findings: Finding[];
  /** appliesTo が真だったルール ID（違反の有無によらない。X-3） */
  applied: string[];
  /** 判定の対象外の行数（FR-111） */
  excludedCount: number;
};

export type Rule = {
  id: string;
  /** 対象区分（§4-4 で「関係あり」の判定に使う。C-6） */
  kubun: string[];
  reference: string;
  appliesTo(ctx: ClaimContext): boolean;
  /** 判定に必要な事実。known=false があれば check を呼ばず「情報不足」 */
  needs(ctx: ClaimContext): NeedKey[];
  check(ctx: ClaimContext): Finding[];
};
