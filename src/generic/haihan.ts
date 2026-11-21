// 背反の特例条件の例外の決まり（design.md §13-1）。config/haihan-exceptions.json は EM §2-12 の HX（例外）・HP（組）の行と 1 対 1（テストで縛る）。
// 例外の決まりは EM の行だけを使う。調べ（tokurei-*.md）は採用値ではない
import raw from "../../config/haihan-exceptions.json";

/** 診療行為の選び方：コードを並べるか、医科診療行為マスターの章・部・区分番号（枝番・項）で選ぶ。通則の加算は区分番号の列で表せないので codes で並べる */
export type CodeSel = { codes?: string[]; section?: { sho: number; bu: number; kubun: number; eda?: number; kou?: number } };
/** レセプトで決まる条件（この 6 つの形だけ。L-71）。sameDay は、判定している算定日に（同一月の表では日を問わない） */
export type ReceiptCond =
  | { all: ReceiptCond[] }
  | { any: ReceiptCond[] }
  | { not: ReceiptCond }
  | { hasCode: CodeSel; sameDay?: boolean }
  | { hasComment: string[]; sameDay?: boolean }
  | { receiptKind: "入院" | "入院外" };
export type Means = "当たる" | "当たらない" | "決まらない";
export type Ask = {
  /** 請求ごとの事実の key（design.md §13-3）。既存の事実と意味が同じもの（sameDayOushinAfterVisit）はその名前、ほかは haihan:<HX-nn>（実際の key は haihan:<HX-nn>:<コード①>:<コード②>） */
  factKey: string;
  /** 答えの単位：day＝算定日ごと／claim＝請求ごと */
  scope: "day" | "claim";
  /** scope=day の同一月の表で、どちらのコードの算定日に問うか（組の a・b は EM の HP の行の意味の順） */
  askOn?: "a" | "b";
  question: string;
  /** 「その他」「判定不能」は means=決まらない */
  choices: { label: string; means: Means }[];
};
export type Check = {
  /** 要件の一言 */
  text: string;
  /** すでにある事実で確かめられる要件。事実が分かっていて ok にない → 例外に当たらない／ok にある → この要件は満たす／不明 → 要件として挙げる（C-121） */
  fact?: { key: string; ok: string[] };
};
export type HaihanException = {
  id: string;
  /** 一言の条件（EM §2-12 表 1。指摘の文に「例外〔一言〕」として出す） */
  text: string;
  /** ア（receipt）・イ（fact）・ウ（none。原文で確かめられなかった例外も） */
  kind: "receipt" | "fact" | "none";
  /** 成り立たなければ、問わずに「当たらない」 */
  pre?: ReceiptCond;
  /** kind=receipt：成り立てば「当たる」 */
  allow?: ReceiptCond;
  /** kind=fact：医療事務に問う */
  ask?: Ask;
  /** 当たったあとに要るもの */
  thenRequires?: { comments?: string[]; checks?: Check[] };
};
export type HaihanPattern = {
  id: string;
  /** この組に当たる背反の行（表と裏の両方の向き） */
  a: CodeSel;
  b: CodeSel;
  tani: (1 | 2 | 3 | 4)[];
  /** 調べで見つかった例外の id の全部 */
  exceptions: string[];
};
export type HaihanConfig = { patterns: HaihanPattern[]; exceptions: HaihanException[] };

export const HAIHAN: HaihanConfig = raw as HaihanConfig;

/** 例外の id → 例外 */
export const exceptionOf = (id: string, config: HaihanConfig = HAIHAN): HaihanException | undefined => config.exceptions.find((x) => x.id === id);

/** 答えを残す key（design.md §13-3）。コードは小さい順 */
export const haihanKey = (hx: string, c1: string, c2: string): string => `haihan:${hx}:${[c1, c2].sort().join(":")}`;
const KEY = /^haihan:(HX-\d{2}):(\d{9}):(\d{9})$/;
/** haihan:<HX-nn>:<コード①>:<コード②> を分ける。形が違えば null */
export function parseHaihanKey(key: string): { hx: string; codes: [string, string] } | null {
  const m = KEY.exec(key);
  return m && m[2] < m[3] ? { hx: m[1], codes: [m[2], m[3]] } : null;
}
/** 既存の事実を使う問いか（その事実の名前）。haihan:* だけの問いなら null */
export const sharedFactOf = (x: HaihanException): string | null => (x.ask && !x.ask.factKey.startsWith("haihan:") ? x.ask.factKey : null);
