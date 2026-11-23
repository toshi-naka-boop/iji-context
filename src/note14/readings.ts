// 注14 の計算の道具の「読みの軸」（design.md §15-13 の「読みの線引き」。W-12）。
// EM §7-2 の下の表「注14 の割れる読み（計算の軸）」の行を写した定数。読み甲・読み乙の語と照会の番号は EM の行のまま（tests/note14/readings.test.ts が EM の行と照らす）。
// 照会の答えが EM に入ったら、その軸をここから外す（1 つの読みになり、組み合わせから外れる）

export type AxisId = "U-27" | "U-30a" | "U-30b" | "U-31a" | "U-31b" | "U-32" | "U-33a" | "U-33b" | "U-33c" | "U-34";
export type Reading = "A" | "B";

/**
 * 軸 1 本。a・b は EM の表の読み甲・読み乙の見出しの語（太字の語か、その欄の初めの語）。inquiry は EM §7-2 の U の行の照会の番号。
 * label は割れたときの 1 行の〔〕の中、whenA・whenB はその行の「〜なら」の部分（定型文。design.md §15-13 の例の形）
 */
export type Axis = { id: AxisId; label: string; a: string; b: string; inquiry: number; whenA: string; whenB: string };

export const AXES: readonly Axis[] = [
  { id: "U-27", label: "回数に入れる区分", a: "狭い", b: "広い", inquiry: 1, whenA: "C001 の行だけなら", whenB: "C001-2 などを入れると" },
  { id: "U-30a", label: "3 月 31 日に開設した機関", a: "告示・通知", b: "様式", inquiry: 5, whenA: "告示・通知の読み（除く）なら", whenB: "様式の読み（足す）だと" },
  { id: "U-30b", label: "開設者を変えた機関の開設日", a: "開設者を変えたあとの新しい開設の日", b: "元の機関が最初に開設した日", inquiry: 5, whenA: "新しい開設の日なら", whenB: "最初に開設した日だと" },
  { id: "U-31a", label: "施設での看取りを入れるか", a: "狭い", b: "広い", inquiry: 6, whenA: "患家だけなら", whenB: "施設も入れると" },
  { id: "U-31b", label: "7 日以内の入院を経た死亡を入れるか", a: "狭い", b: "広い", inquiry: 6, whenA: "入れないなら", whenB: "入れると" },
  { id: "U-32", label: "紹介の文書と特別の関係の機関", a: "狭い", b: "広い", inquiry: 7, whenA: "狭く数えるなら", whenB: "広く数えると" },
  { id: "U-33a", label: "①② の数え方", a: "実人数", b: "月ごとの延べ", inquiry: 8, whenA: "実人数なら", whenB: "月ごとの延べだと" },
  { id: "U-33b", label: "③ の除き方", a: "1 回でも", b: "算定した月の分だけ", inquiry: 8, whenA: "1 回でも当たれば除くなら", whenB: "算定した月の分だけ除くと" },
  { id: "U-33c", label: "⑤ の数え方", a: "1 回でも", b: "各月の末日", inquiry: 8, whenA: "1 回でも当たれば数えるなら", whenB: "各月の末日の状態だと" },
  { id: "U-34", label: "開設してすぐ", a: "ある期間で数える", b: "そろわない要件は満たさない", inquiry: 9, whenA: "ある期間で数えるなら", whenB: "そろわない要件を満たさないとすると" },
];

export const axisOf = (id: AxisId): Axis => AXES.find((a) => a.id === id)!;

/** 読みの組み合わせ（軸 → 読み）。組に入れない軸は甲として読む（その施設の入力では甲乙で値が変わらない軸） */
export type Combo = Partial<Record<AxisId, Reading>>;
export const readingOf = (c: Combo, id: AxisId): Reading => c[id] ?? "A";
