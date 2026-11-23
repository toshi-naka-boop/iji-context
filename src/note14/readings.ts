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

/**
 * 2 段目の欄（design.md §15-13「欄の数は軸から決める」。round-57 X-174＝C-321・X-170＝C-322。round-59 C-343）。
 * 並びは様式19の2 の 2(1)〜2(3) の欄の順（EM R8-197〜R8-200 の出どころの様式）。axes は、その欄の数え方が変わる軸（依る軸）で、欄は依る軸の読みの組み合わせごとに 1 つ出す。
 * 看取りは患家・施設・7 日以内の入院を経た死亡の 3 欄で、欄そのものは読みで分けない（U-31a・U-31b は和に足すかだけを変える。W-11）。
 * period は実績の期間（short＝3 か月、long＝1 年。EM R8-196。U-34 の「そろわない要件」に使う）
 */
export type FieldId = "referral" | "mitoriHome" | "mitoriFacility" | "mitoriHospital" | "jushoji" | "c002" | "c0022" | "excluded" | "care";
export type FieldDef = { id: FieldId; label: string; form: string; requirement: "R8-197" | "R8-198" | "R8-199" | "R8-200"; axes: readonly AxisId[]; period: "short" | "long" };

export const FIELDS: readonly FieldDef[] = [
  { id: "referral", label: "文書による紹介を受けて訪問診療を始めた紹介元の機関の数", form: "2(1)", requirement: "R8-197", axes: ["U-32"], period: "long" },
  { id: "mitoriHome", label: "患家での看取りの件数", form: "2(2)", requirement: "R8-198", axes: [], period: "long" },
  { id: "mitoriFacility", label: "施設（特養・有料老人ホーム等）での看取りの件数", form: "2(2)", requirement: "R8-198", axes: [], period: "long" },
  { id: "mitoriHospital", label: "7 日以内の入院を経た死亡の件数", form: "2(2)", requirement: "R8-198", axes: [], period: "long" },
  { id: "jushoji", label: "超重症児・準超重症児への在宅医療の実績の件数（判定は医師）", form: "2(2)", requirement: "R8-198", axes: [], period: "short" },
  { id: "c002", label: "① C002 を算定した患者の数", form: "2(3)①", requirement: "R8-199", axes: ["U-33a"], period: "short" },
  { id: "c0022", label: "② C002-2 を算定した患者の数", form: "2(3)②", requirement: "R8-199", axes: ["U-33a"], period: "short" },
  { id: "excluded", label: "③ ② のうち除く患者等の数", form: "2(3)③", requirement: "R8-199", axes: ["U-33a", "U-33b"], period: "short" },
  { id: "care", label: "⑤ ① と ② のうち要介護3 以上又は別表第八の二の状態の患者等の数", form: "2(3)⑤", requirement: "R8-200", axes: ["U-33a", "U-33c"], period: "short" },
];

/** 欄の鍵（欄の id と、依る軸の読み。例 "excluded:U-33a=A:U-33b=B"） */
export const fieldKeyOf = (f: Pick<FieldDef, "id" | "axes">, c: Combo): string => [f.id, ...f.axes.map((a) => `${a}=${readingOf(c, a)}`)].join(":");

/** 欄の一覧（依る軸の読みの組み合わせごとに 1 つ。定数から決め、画面に手で並べない） */
export function fieldKeys(defs: readonly FieldDef[] = FIELDS): { key: string; field: FieldDef; combo: Combo; label: string }[] {
  return defs.flatMap((f) =>
    f.axes
      .reduce<Combo[]>((acc, a) => acc.flatMap((c) => [{ ...c, [a]: "A" as const }, { ...c, [a]: "B" as const }]), [{}])
      .map((combo) => ({ key: fieldKeyOf(f, combo), field: f, combo, label: f.axes.length === 0 ? f.label : `${f.label}（${f.axes.map((a) => (readingOf(combo, a) === "A" ? axisOf(a).a : axisOf(a).b)).join("・")}）` })),
  );
}
