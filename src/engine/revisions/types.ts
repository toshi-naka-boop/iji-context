// 改定の版の型（design.md §2-4・§2-5・§2-3-2）。点数表・ルールの定数・ルール一式は版に属する
import type { Rule } from "../types";

/** 区分の定義。points が null の区分は点数未収載（合計は null になる） */
export type KubunDef = { name: string; points: number | null; source: "A21" | "EM5" | "未収載" };

/**
 * 版に属するルールの定数（§2-3-2）。ルール本体は区分・閾値を直書きせず、ここから受け取る。
 * 点数は入れない（点数表の持ち物で、ルールは点数を見ない）
 */
export type RevisionConsts = {
  /** 訪問診療料。[同一建物居住者以外, 同一建物居住者] */
  visitKubun: string[];
  /** 在医総管の区分。all は 2イ・2ロ・2ニ の順 */
  kanri: { all: string[]; severe: string; twice: string; once: string };
  /** 包括的支援加算（R02・R03） */
  hokatsu: { kubun: string; careLevelMin: number };
  /** 在宅療養指導管理料（R04） */
  shidoKanriKubun: string[];
  /** 在医総管に包括される項目と、処方箋を交付しない場合の加算（R05） */
  bundled: { kubun: string[]; noRxAddition: string };
  /** 特定疾患処方管理加算（R06）。対象外の主病と、処方日数の下限 */
  tokutei: { kubun: string; excludedDiseases: string[]; minDays: number };
  /** 処方箋料（R07）。内服の種類数がこの数以上なら many、それ以外は other */
  rx: { oralKindsThreshold: number; many: string; other: string };
  /** ベースアップ評価料(Ⅰ)（R08）。visit は [同一建物居住者以外, 同一建物居住者] */
  baseUp: { visit: string[]; revisit: string };
  /** 看取り・死亡診断・ターミナルケア（R09）。死亡日前 days 日以内に minVisits 回以上 */
  terminal: { mitori: string; shibou: string; terminal: string; days: number; minVisits: number };
  /** 往診料と緊急往診加算（R10） */
  oushin: { kubun: string; kinkyu: string };
  /** 検体検査判断料・BNP・外来迅速検体検査加算（R11） */
  tests: { judgement: string[]; bnp: string; bnpJudgement: string; rapid: string };
  /** 在宅医療DX情報活用加算と、同月に併算定できない加算（R12） */
  dx: { kubun: string; conflicts: string[] };
  /** 訪問診療の週の上限（R13）。週は日曜始まり */
  weeklyVisitLimit: number;
  /** 在宅移行早期加算（R14）。算定開始月から months か月目まで、退院から daysFromDischarge 日以内 */
  ikou: { kubun: string; months: number; daysFromDischarge: number };
};

export type Revision = {
  id: string;
  label: string;
  /** 属する改定（例 "R6"）。値の変更の版も同じ generation を持つ */
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
