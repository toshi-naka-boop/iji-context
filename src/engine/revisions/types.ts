// 改定の版の型（design.md §2-4・§2-5・§2-3-2）。点数表・ルールの定数・ルール一式は版に属する
import type { FacilityFactKey, Residence, Rule } from "../types";

/**
 * 区分の定義。points が null の区分は点数未収載（合計は null になる）。
 * no は区分番号の表示（例 "D008 19"）で、判定には使わない。source の "EM" は evidence-master の採用値
 */
export type KubunDef = { name: string; no: string; points: number | null; source: "EM" | "未収載" };

/** 管理料の族 */
export type KanriFamily = "在医総管" | "施設総管";
/** 管理料の区分（2イ＝重症・月2回以上／2ロ＝月2回以上／2ニ＝月1回） */
export type KanriTierKey = "イ" | "ロ" | "ニ";

/**
 * 版に属するルールの定数（§2-3-2）。ルール本体は区分・閾値を直書きせず、ここから受け取る。
 * 点数は入れない（点数表の持ち物で、ルールは点数を見ない）
 */
export type RevisionConsts = {
  /** 訪問診療料。[同一建物居住者以外, 同一建物居住者] */
  visitKubun: string[];
  /** 管理料（R01・R02・R03・R16）。族×区分 → kubun、居住の場所 → 族、注16 で替わる区分（from → to。両方の族） */
  kanri: {
    table: Record<KanriFamily, Record<KanriTierKey, string>>;
    familyOf: Record<Residence, KanriFamily>;
    note16: { from: KanriTierKey; to: KanriTierKey };
  };
  /** 包括的支援加算（R02・R03）。tiers は加算の対象の区分 */
  hokatsu: { kubun: string; careLevelMin: number; tiers: KanriTierKey[] };
  /** 在宅療養指導管理料（R04） */
  shidoKanriKubun: string[];
  /** 管理料に包括される項目と、処方箋を交付しない場合の加算（R05） */
  bundled: { kubun: string[]; noRxAddition: string };
  /** 特定疾患処方管理加算（R06）。対象外の主病と、処方日数の下限 */
  tokutei: { kubun: string; excludedDiseases: string[]; minDays: number };
  /** 処方箋料（R07）。内服の種類数がこの数以上なら many、それ以外は other */
  rx: { oralKindsThreshold: number; many: string; other: string };
  /** ベースアップ評価料(Ⅰ)（R08）。visit は [同一建物居住者以外, 同一建物居住者]。overlapKey は両方を算定した日の重ねを決める施設の設定 */
  baseUp: { visit: string[]; revisit: string; overlapKey: FacilityFactKey };
  /** 物価対応料（R15）。形は baseUp と同じ */
  price: { visit: string[]; revisit: string; overlapKey: FacilityFactKey };
  /** 看取り・死亡診断・ターミナルケア（R09）。死亡日前 days 日以内に minVisits 回以上 */
  terminal: { mitori: string; shibou: string; terminal: string; days: number; minVisits: number };
  /** 往診料と緊急往診加算（R10）。revisit は往診料と併せて算定する再診料（導出の D02） */
  oushin: { kubun: string; kinkyu: string; revisit: string };
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
};

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
  consts: RevisionConsts;
  /** consts から工場関数で組み立てたもの */
  rules: Rule[];
};
