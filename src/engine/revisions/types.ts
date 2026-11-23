// 改定の版の型（design.md §2-4・§2-5・§2-3-2）。点数表・ルールの定数・ルール一式は版に属する
import type { BuildingBand, FacilityFactKey, FacilityGrade, Residence, Rule } from "../types";

/**
 * 区分の定義。points が null の区分は点数未収載（合計は null になる）。
 * no は区分番号の表示（例 "D008 19"）で、判定には使わない。source の "EM" は evidence-master の採用値
 */
export type KubunDef = { name: string; no: string; points: number | null; source: "EM" | "未収載" };

/** 管理料の族 */
export type KanriFamily = "在医総管" | "施設総管";
/** 管理料の区分（イ＝重症・月2回以上／ロ＝月2回以上／ニ＝月1回。種別によらず同じ 3 つ） */
export type KanriTierKey = "イ" | "ロ" | "ニ";

/**
 * 管理料の区分の表の 1 行（design.md §15-4）：族×施設の種別×区分 → kubun。
 * band は単一建物診療患者の数の区分（EM R8-94。段 17f。省いた行は 1 人の区分）。R01・R02・R16 は band・grade を見ず、R18 は grade だけ、R19 は band だけを見る（§0-12）
 */
export type KanriRow = {
  kubun: string;
  family: KanriFamily;
  grade: FacilityGrade;
  tier: KanriTierKey;
  band?: Exclude<BuildingBand, "1">;
  /** 注14 の減の行（減＝注14 だけ、注8減＝注8 と重ねた行。段 17h）。族・種別・区分・人数の区分は組の通常の区分（note14Pairs）と同じ。省いた行は通常の行。R18 だけがこの次元を見る（§0-12） */
  note14?: "減" | "注8減";
};

/** 施設の種別で分かれる加算の、種別 → kubun（その版に区分のない種別は持たない） */
export type ByGrade = Partial<Record<FacilityGrade, string>>;

/**
 * 版に属するルールの定数（§2-3-2）。ルール本体は区分・閾値を直書きせず、ここから受け取る。
 * 点数は入れない（点数表の持ち物で、ルールは点数を見ない）
 */
export type RevisionConsts = {
  /** 訪問診療料。[同一建物居住者以外, 同一建物居住者] */
  visitKubun: string[];
  /**
   * 管理料（R01・R02・R03・R16・R18）。族×種別×区分の行の表（KanriRow）、居住の場所 → 族、注16 で替わる区分（from → to。どの族・種別も）。
   * note16.enabled が偽の版（注16 のない版）では、施設の設定 note16Met を読まず、月 2 回以上は ロ のまま（design.md §11-2）
   */
  kanri: {
    rows: KanriRow[];
    familyOf: Record<Residence, KanriFamily>;
    note16: { enabled: boolean; from: KanriTierKey; to: KanriTierKey };
    /** 注14 の減の行 → 対応する通常の区分（design.md §15-4。段 17h）。持たない版では、減の行を持たず、請求の注14 の側は「なし」 */
    note14Pairs?: Record<string, string>;
  };
  /** 注14（EM R8-191・R8-201）：基準を確かめる確認月（月の数字）。申告 note14 の確かめ直す日の既定（次の確認月の末日）に使う。持たない版では注14 の申告を聞かない */
  note14?: { checkMonths: number[] };
  /** 包括的支援加算（R02・R03）。tiers は加算の対象の区分。要介護度・障害支援区分がそれぞれの下限以上なら対象 */
  hokatsu: { kubun: string; careLevelMin: number; disabilityLevelMin: number; tiers: KanriTierKey[] };
  /** 在宅療養指導管理料（R04） */
  shidoKanriKubun: string[];
  /** 管理料に包括される項目と、処方箋を交付しない場合の加算（R05） */
  bundled: { kubun: string[]; noRxAddition: string };
  /** 特定疾患処方管理加算（R06）。対象外の主病と、処方日数の下限 */
  tokutei: { kubun: string; excludedDiseases: string[]; minDays: number };
  /** 処方箋料（R07）。内服の種類数がこの数以上か、向精神薬の長期処方なら many（区分 2）、それ以外は other（区分 3） */
  rx: { oralKindsThreshold: number; many: string; other: string };
  /**
   * ベースアップ評価料(Ⅰ)（R08・R18）。visit は [同一建物居住者以外, 同一建物居住者]。overlapKey は両方を算定した日の重ねを決める施設の設定。
   * note5 は、通常の区分 → 同じ区分（初診時・再診時等・訪問診療時イ・ロ）の注5 の区分（design.md §15-4。X-133）。持たない版では注5 を導出しない
   */
  baseUp: { visit: string[]; revisit: string; overlapKey: FacilityFactKey; note5?: Record<string, string> };
  /** 物価対応料（R15）。形は baseUp と同じ */
  price: { visit: string[]; revisit: string; overlapKey: FacilityFactKey };
  /**
   * 看取り・死亡診断・ターミナルケア（R09・R18）。terminal は施設の種別 → 在宅ターミナルケア加算の区分（design.md §15-4。X-135）。死亡日前 days 日以内に minVisits 回以上。
   * 請求の判定に使う版（REVISIONS）は days・minVisits を必ず持つ。持たない版（比較用の版で、値を EM で確かめていないもの）では、ターミナルケア加算を導出しない
   */
  terminal: { mitori: string; shibou: string; terminal: ByGrade; days?: number; minVisits?: number };
  /** 往診料と緊急往診加算（R10・R18）。kinkyu は施設の種別 → 緊急往診加算の区分（design.md §15-4。X-139）。revisit は往診料と併せて算定する再診料（導出の D02） */
  oushin: { kubun: string; kinkyu: ByGrade; revisit: string };
  /** 検体検査判断料・BNP・外来迅速検体検査加算（R11）。bloodDraw は血液採取（導出の D09） */
  tests: { judgement: string[]; bnp: string; bnpJudgement: string; rapid: string; bloodDraw: string };
  /** 検査の出来事の項目名 → 区分と判断料（導出の D09）。表にない項目名は導出しない */
  testItems: Record<string, { kubun: string; judgement: string }>;
  /** 在宅医療DX情報活用加算（届出区分 → kubun）と、同月に併算定できない加算（R12） */
  dx: { tiers: Record<"1" | "2", string>; conflicts: string[] };
  /** 訪問診療料の週の上限（R13）と、週の始まりの曜日（0＝日曜） */
  weeklyVisitLimit: number;
  weekStartsOn: number;
  /** 在宅移行早期加算（R14）。算定開始月から months か月目まで、退院から daysFromDischarge 日以内 */
  ikou: { kubun: string; months: number; daysFromDischarge: number };
  /** 在宅療養移行加算（R18。在支診以外〔種別 3〕に限る）。導出はしない。持たない版は空 */
  ikouGrade3?: string[];
  /**
   * 算定の要件と取り忘れを見ていない区分（C〜I の手順に回した：在宅医療充実体制加算・在宅療養実績加算・在宅療養移行加算・注8 の減算。design.md §15-4。L-92）。
   * 点検の範囲に「見ていません」と数を出す。注8 の減算の対象になる管理料（種別 3 の管理料の行）も同じに数える
   */
  deferred?: string[];
};

/**
 * 区分 → 実在の診療行為コード（design.md §11-1・§11-14。値は EM §2-8 の行だけ）。
 * primary は書き出しに使う 1 つ、accept は読み取りで同じ区分として受けるほかのコード（アプリの区分がマスターより粗いとき）。
 * facility は、施設に入居する患者の書き出しに使うコード（accept の 1 つ。在宅ターミナルケア加算だけ）。
 * quantity が真の区分は、きざみで算定する（数量データの欄に項目数を書き、点数は 1 項目あたりの点数 × 項目数）。
 * base は注加算の基本の項目（同じ点数・回数の算定単位に入り、合算の点数を単位の最後の行に書く）
 */
export type CodeDef = { primary: string; accept: string[]; facility?: string; quantity?: true; base?: string };

/**
 * 包括の検査（design.md §11-1。型の定義はここ 1 か所）。項目のコード（members）を 1 行ずつ並べ、項目数で区分が決まる。
 * tiers は min の昇順で、項目数が min 以上の最後の区分を採る。最初の min に届かない項目数は、どの区分にもならない
 */
export type Bundle = { members: string[]; tiers: { min: number; kubun: string }[] };

/**
 * 摘要欄に要る記載（design.md §11-13。値は EM §2-10 表 1 の行だけ）。
 * kubun のどれかの行があり、when が成り立つとき、codes のコメントが要る（need が any ならどれか 1 つ、each なら全部）。
 * when：always＝算定すれば必ず／sameDayVisitAndOushin＝訪問診療料と往診料の両方を算定した日がある（要る数は、その日の数以上）／
 * acuteOver3PerWeek＝別表第七に当たらず、急性増悪で、週の上限を超える訪問診療料がある／deathNotAtHome＝在宅以外で死亡した。
 * compare は、コメントの中身と行・事実の突き合わせ（R17 の comment_mismatch_*）
 */
export type CommentRule = {
  /** EM §2-10 表 1 の行の id */
  id: string;
  kubun: string[];
  codes: string[];
  need: "any" | "each";
  when: "always" | "sameDayVisitAndOushin" | "acuteOver3PerWeek" | "deathNotAtHome";
  compare?: "visitDates" | "acuteVisitDates" | "deathDate" | "hokatsuState" | "ikouStart";
  /** 何を書くか（画面に出す要旨） */
  summary: string;
  /** EM の出どころ */
  em: string;
};

/**
 * コメントコードごとの補足（EM §2-10 表 1・表 1-a）。CommentRule の形では表せないことだけを持つ。
 * family：その族の管理料の行があるときに使うコード（在医総管と施設総管でコードが違う記載）／
 * careLevel：その要介護度に当たる状態のコード／disabilityLevelMin：障害支援区分がその数以上に当たる状態のコード／
 * visited：急性増悪の「訪問診療を行った年月日」のコード（acuteVisitDates が比べる）
 */
export type CommentCodeNote = { family?: KanriFamily; careLevel?: number; disabilityLevelMin?: number; visited?: true };

export type Revision = {
  id: string;
  label: string;
  /** 属する改定（例 "R8"）。値の変更の版も同じ generation を持つ */
  generation: string;
  kind: "改定" | "値の変更";
  /** 適用開始の診療年月 "YYYY-MM"（含む） */
  effectiveFrom: string;
  /** 適用終了の診療年月 "YYYY-MM"（含む） */
  effectiveUntil: string;
  points: Record<string, KubunDef>;
  /**
   * 点数表の各区分は、codes（コード 1 つ）・bundles（項目のコードの集まり）・uncoded（コードを持たない。値は理由）のちょうど 1 つに載る。
   * コードは改定で廃止・新設されるので版が持つ。コードから区分を引くときは、必ず先に版を決める（同じコードが、別の版では別の区分キーに当たることがある）
   */
  codes: Record<string, CodeDef>;
  bundles: Bundle[];
  uncoded: Record<string, string>;
  /** 区分 → 診療識別（別表20。2 桁）。UKE の書き出しにだけ使い、読み取りでは判定に使わない。codes・bundles の区分は必ず持つ */
  shikibetsu: Record<string, string>;
  consts: RevisionConsts;
  /** 摘要欄に要る記載（R17 と、導出の「摘要欄に書くこと」が同じ表を使う） */
  comments: CommentRule[];
  commentCodes: Record<string, CommentCodeNote>;
  /** consts（R17 は comments・commentCodes も）から工場関数で組み立てたもの */
  rules: Rule[];
  /** その版で、前の改定から変わった点（design.md §11-2）。人が EM を見て書く。値の変更の版は持たない（空） */
  changes: RevisionChange[];
};

/**
 * 前の改定から変わった点の 1 件（値は EM §2-9「変わった点」の行だけ）。
 * target は対象の区分とルール（前の版にしかない区分も入る）。summary は要旨（120 字まで）、em は EM の出どころ
 */
export type RevisionChange = {
  id: string;
  target: { kubun?: string[]; ruleId?: string };
  kind: "新設" | "廃止" | "点数" | "要件" | "区分の再編";
  summary: string;
  em: string;
};
