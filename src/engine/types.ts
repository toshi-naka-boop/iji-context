// ルールエンジンの入出力の型（design.md §2-1・§2-2）
import type { Revision } from "./revisions/types";

/** 三値の事実。known=false は「わからない」（C-4） */
export type Fact<T> = { known: true; value: T } | { known: false };

export type Payer = "支払基金" | "国保連";

/** 施設の種別（design.md §15-2）：1B＝機能強化型・病床あり／1N＝機能強化型・病床なし／2＝在支診（(2)イ・(3)）／3＝在支診以外 */
export type FacilityGrade = "1B" | "1N" | "2" | "3";

export type Facility = {
  /** 施設の種別（施設の申告から決める。判定に使うのは段 17c から） */
  grade: Fact<FacilityGrade>;
  /** 在宅療養支援診療所か。null は施設の種別が分からない（申告がない・確かめ直す日を過ぎたなど。design.md §15-2） */
  zaishishin: boolean | null;
  /** 機能強化型か（null は種別が分からない） */
  kyokagata: boolean | null;
  /** 病床があるか（null は種別が分からない） */
  hasBeds: boolean | null;
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
export type FacilityFactKey = "grade" | "dxTier" | "baseUp" | "priceResponse" | "note16Met" | "revisitBaseUpSameDay" | "revisitPriceSameDay";

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
  /** 障害支援区分（0＝認定なし、1〜6）。R03・D04 が読む。医療事務が受給者証・カルテで確かめる（design.md §11-4） */
  disabilitySupportLevel: Fact<number>;
  /**
   * 要介護度と障害支援区分のほかに、別表第八の三（包括的支援加算の対象）のどれかの状態に当たるか。R03・D04 が読む。
   * 認知症高齢者の日常生活自立度 Ⅲ 以上、週 1 回以上の訪問看護、訪問診療・訪問看護での処置、
   * 看護職員が配置された施設での処置、麻薬の投薬、その他（EM R8-15a の (2)〜(7)）。要介護 3 以上は careLevel、障害支援区分 2 以上は disabilitySupportLevel で見る
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
  /**
   * 同じ日の訪問診療と往診が、別々の診療かを確かめた答え（日付 → 真偽）。載っていない日は不明。
   * 役目は、実施の回数を数える（R09）ことと、1 回の診療かを見る（R10 の same_encounter）ことだけ。往診料を立てる条件は sameDayOushinAfterVisit で見る（design.md §11-5）
   */
  sameDaySeparate: Fact<Record<string, boolean>>;
  /** その日、訪問診療のあとに、病状の急変などで往診したか（日付 → 真偽）。載っていない日は不明。同じ日の往診料を立てる条件（R10・D02。EM #7-8 改） */
  sameDayOushinAfterVisit: Fact<Record<string, boolean>>;
  /** 退院時共同指導料1 を算定したか。在宅ターミナルケア加算の別の経路（R09・D12。EM #7-11）。医療事務が確かめる */
  dischargeJointGuidance: Fact<boolean>;
  /** その日の処方が、向精神薬（不安・不眠の薬）の 1 年以上の継続処方に当たるか（処方の日付 → 真偽）。載っていない日は不明（R07・D10。EM #7-15）。医師が確かめる */
  rxLongPsychotropic: Fact<Record<string, boolean>>;
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
  /**
   * oralKinds：F200 注3 の数え方で数えた、常態として投与する内服薬の種類数（EM #7-14）。数えるのは入力する側で、エンジンは数え方（薬価・臨時の投薬）を適用しない。
   * psychotropic：その処方に、処方箋料の区分 2 の対象になる不安・不眠の薬が含まれるか（EM #7-15）。null は「分からない」で、「含まれない」とはみなさない
   */
  | { type: "prescription"; date: string; oralKinds: number; days: number; psychotropic: boolean | null }
  | { type: "death"; date: string }
  | { type: "discharge"; date: string }
  /** 管理料（在医総管・施設総管）の算定開始月（"YYYY-MM"） */
  | { type: "kanriStart"; month: string };

export type ClaimLine = { kubun: string; count: number; dates: string[] };

/** 摘要欄のコメント（design.md §11-13） */
export type Comment = {
  /** 9 桁のコメントコード */
  code: string;
  /** 文字データ。全角の数字・記号を半角に寄せたもの */
  text: string;
  /** 文字データの原文 */
  raw: string;
  /**
   * 同じ点数・回数の算定単位にある行の区分。埋めるのは、帰属が記録の形式から決まるコメントだけ（診療行為のレコードのコメント欄と、単位の途中にある診療識別が空の CO）。
   * レセプト全体へのコメントと、単位の前後に置かれたコメント（どの単位に掛かるかが形式から決まらない）は空
   */
  on: string[];
};

export type ClaimContext = {
  claimId: string;
  yearMonth: string;
  facility: Facility;
  payer: Payer;
  prefecture: string;
  facts: Facts;
  events: ClaimEvent[];
  /**
   * カルテ側の記録（出来事）があるか。偽の請求（見本以外の UKE）では、空の出来事を「なかった」と読まない：
   * 出来事を読んで決める指摘（Rule.recordFindings）は出さず、情報不足（chartRecord）を返す（design.md §11-6）
   */
  recordsKnown: boolean;
  lines: ClaimLine[];
  /** 摘要欄のコメント（UKE のコメント欄と CO レコードから作る）。commentsKnown が真なら、載っていないものは「なかった」 */
  comments?: Comment[];
  /**
   * コメントを持つ作り方の請求か（design.md §11-13）。UKE から作った請求は真。
   * コメントを持たない作り方（練習問題・選択モード・同梱の症例の JSON・カルテからの下書き・コメントの載らない連携）は偽で、空のコメントを「なかった」と読まない
   */
  commentsKnown: boolean;
  /**
   * 点検の対象外の単位（引けないコードを含む算定単位）が 1 つ以上ある請求か（design.md §11-11）。真の請求では、lines は請求の一部でしかない：
   * ほかの行の有無や回数で決まる指摘は当てにならないので、evaluate は Rule.soundWhenPartial に申告のある種類の指摘だけを出し、合計を出さない。省くと偽
   */
  partial?: boolean;
  /**
   * 対象外の単位のコードを、基本マスターで引いたもの（design.md §12-4）。基本マスターがある請求だけが持つ（引くのは呼び出し側。エンジンは DB を開かない）。
   * 持つ請求では、止めるかどうかをルールごとに決める（src/engine/index.ts の partialBy）。持たない請求は、対象外の単位が 1 つでもあれば、どのルールも止める（v23 のまま）
   */
  outside?: Outside;
  /** 過去月の算定（設定ファイルの固定値。spec 決定62）。載っていない月は「算定なし」 */
  history?: { yearMonth: string; kubun: string[] }[];
};

/**
 * 対象外の単位にあるコード 1 つ。known は、診療年月に使う 1 枚のマスター（医科診療行為・医薬品・特定器材のどれか）にあるか。
 * no は区分番号の鍵（医科診療行為マスターのコード表用番号の「章/部/区分番号」。枝番・項番は入れない）。医薬品・特定器材と、マスターにないコードは null
 */
export type OutsideCode = { code: string; known: boolean; no: string | null };

/** codes は対象外の単位のコード（重複は除く）。noOf は、版の区分 → その区分のコード（primary。包括の検査は項目）の区分番号の鍵。マスターで引けなかった区分は載らない */
export type Outside = { codes: OutsideCode[]; noOf: Record<string, string[]> };

/** 「記載もれ」は摘要欄の記載（R17）。宛先は医療事務で、点数は付かない（design.md §11-13） */
export type FindingKind = "不一致" | "背反" | "取り忘れ" | "区分誤り" | "要件不足" | "記載もれ" | "情報不足";

export type Finding = {
  ruleId: string;
  kind: FindingKind;
  lineRefs: string[];
  /** 情報不足のとき。施設の設定は field が "facility.<key>"。"rxRecord" は、その日の処方の記録と行の対応がとれないこと、"chartRecord" は、カルテ側の記録がない請求であること、"unsupportedLines" は、点検の対象外の行がある請求（partial）で決められない指摘があること（どれも事実のキーではなく、入力では消えない）。date は日付ごとの事実（sameDaySeparate など）と rxRecord の対象の日 */
  missing?: { target: "doctor" | "clerk"; field: string; date?: string };
  messageKey: string;
  /** 文言に埋める値（R17：何の記載か、足りない日・多い日） */
  params?: Record<string, string>;
  reference: string;
};

export type EngineResult = {
  claimId: string;
  /** 判定に使った版 */
  revisionId: string;
  /** 点数未収載の行、点検の対象外の単位（partial）があれば null */
  total: number | null;
  /** 点検の対象外の単位がある請求（partial）でだけ持つ：点検した行の小計（請求の合計ではない。点数未収載の行があれば null） */
  subtotal?: number | null;
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
  /**
   * このルールの指摘の種類（messageKey の「ルール id.」より後ろ）のうち、出来事を読んで決めるもの。
   * カルテ側の記録がない請求（recordsKnown が偽）では、evaluate がこの種類の指摘を捨て、情報不足（chartRecord）を 1 件返す（design.md §11-6）
   */
  recordFindings: string[];
  /**
   * このルールの指摘の種類のうち、いまある行と確かめた事実だけから言えるもの（許可の一覧。design.md §11-11）。
   * 点検の対象外の単位がある請求（partial）では、evaluate がここにない種類の指摘を捨て、情報不足（unsupportedLines）を 1 件返す。
   * 申告のない種類は出ない（申告漏れは見逃しに倒れ、誤った指摘には倒れない）。申告が正しいことは tests/engine/partial.test.ts が縛る
   */
  soundWhenPartial: string[];
  /**
   * このルールが「あるか・ないか・何回か・どの日か」を見る区分（design.md §12-4）。kubun を含み、述語を通して読む区分（訪問診療料の回数・往診料の日など）も全部挙げる。
   * 基本マスターがある請求では、対象外の単位に、ここの区分と同じ区分番号のコード（か、マスターにないコード）があるときだけ、このルールを partial として扱う。
   * 申告のないルールは、対象外の単位が 1 つでもあれば止める（v23 のまま）。申告が足りていることは tests/engine/reads.test.ts が縛る
   */
  reads?(rev: Revision): string[];
  /**
   * このルールが「判定する」と申告する組（design.md §12-2。データで動く点検との重なりを、src/generic/overlap.ts が決めるのに使う）。
   * kind は、データで動く点検の種類（包括・背反・回数・記載もれ・傷病名）。finding は、その組が当たるときにこのルールが出す指摘の種類（messageKey の「ルール id.」より後ろ）。
   * kubun は組の一覧：包括・背反は 2 つの区分の組、回数・記載もれ・傷病名は 1 つの区分。判定そのものは変えない（申告だけ）。申告と電子点数表の行の対応は tests/generic/overlap-real.test.ts が確かめる
   */
  covers?(rev: Revision): { kind: "包括" | "背反" | "回数" | "記載もれ" | "傷病名"; finding: string; kubun: string[][] };
  appliesTo(ctx: ClaimContext): boolean;
  /** 判定に必要な事実。known=false があれば check を呼ばず「情報不足」 */
  needs(ctx: ClaimContext): NeedKey[];
  check(ctx: ClaimContext): Finding[];
};
