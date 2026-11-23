// 注14 の計算の道具の判定（design.md §15-13。FR-204）。決まった規則だけで、LLM は使わない。点数・金額は出さない（回数・人数・割合の比較だけ）。
// 値（門の回数・期間・機関の数・件数・割合）は確認月の版の定数（rev.consts.note14。EM R8-194〜R8-201）から受け取り、ここに数を直書きしない。
// 明文のない点（readings.ts の軸）は、アプリが一方に決めず、読みの全部の組み合わせで計算する。全部で同じ結果のときだけ言い切り、割れたら「決めきれない」と割れた軸ごとに 1 行を出す（W-12）。
// 割合は丸めず、EM R8-199・R8-200 の「整数で比べる形」の不等式で比べる
import type { RevisionConsts } from "../engine/revisions/types";
import { AXES, axisOf, fieldKeyOf, fieldKeys, FIELDS, readingOf, type AxisId, type Combo, type FieldId } from "./readings";

export type Note14Consts = Required<NonNullable<RevisionConsts["note14"]>>;

/** 道具の対象の版か（確認月の版が計算の値を全部持つ） */
export function toolConstsOf(c: RevisionConsts["note14"] | undefined): Note14Consts | null {
  if (!c) return null;
  const { visitThreshold, periodMonths, excludeOpenedOnOrBefore, referralMin, mitoriMin, jushojiMin, ratio199, ratio200, countRows } = c;
  if (visitThreshold === undefined || !periodMonths || !excludeOpenedOnOrBefore || referralMin === undefined || mitoriMin === undefined || jushojiMin === undefined || !ratio199 || !ratio200 || !countRows) return null;
  return { checkMonths: c.checkMonths, visitThreshold, periodMonths, excludeOpenedOnOrBefore, referralMin, mitoriMin, jushojiMin, ratio199, ratio200, countRows };
}

/** "YYYY-MM" を n か月ずらす */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** 確認月 M の前の n か月（古い順。M は含まない） */
export const monthsBefore = (m: string, n: number): string[] => Array.from({ length: n }, (_, i) => shiftMonth(m, i - n));

/** 使った期間（EM R8-196・U-35。確認月 M に対して M-3〜M-1 と M-12〜M-1。C-325） */
export type Period = { short: { from: string; to: string }; long: { from: string; to: string } };
export const periodOf = (m: string, c: Pick<Note14Consts, "periodMonths">): Period => ({
  short: { from: shiftMonth(m, -c.periodMonths.short), to: shiftMonth(m, -1) },
  long: { from: shiftMonth(m, -c.periodMonths.long), to: shiftMonth(m, -1) },
});
export const isCheckMonth = (m: string, c: Pick<Note14Consts, "checkMonths">): boolean => c.checkMonths.includes(Number(m.slice(5, 7)));

/** 1 段目の月ごとの回数（kou＝読み甲の行の回数、otsuExtra＝読み乙だけの行の回数。source は自動で数えた〔本人が確かめた月〕か手入力か） */
export type MonthCount = { month: string; kou: number | null; otsuExtra: number | null; source: "auto" | "manual" };
/** 特別の関係にある保険医療機関 1 つ（openedOn＝開設日、ownerChangedFrom＝開設者を変えたときの元の機関が最初に開設した日、count＝期間の回数） */
export type Institution = { openedOn: string | null; ownerChangedFrom: string | null; count: number | null };
export type Stage1Input = {
  months: MonthCount[];
  /** 読み乙だけの手入力の欄（期間の合計）：在宅がん医療総合診療料で訪問した日の回数、同一の患家の 2 人目以降で初診料・再診料を算定した日の回数。null は空の欄（0 と数えない。C-323） */
  gansou: number | null;
  secondPatient: number | null;
  special: "none" | "some" | "unknown";
  institutions: Institution[];
};
/**
 * 2 段目の入力（段 17j）。values は欄の鍵（readings.ts の fieldKeys）→ 数（null は空の欄）。openedOn は開設日（期間の初めより後に開設したときだけ。U-34）。
 * sources は欄ごとの出どころ（auto＝下書きのまま、manual＝本人が入れた・直した。段 17k）
 */
export type Stage2Input = { values: Record<string, number | null>; openedOn: string | null; sources?: Record<string, "auto" | "manual"> };
export type WorksheetInput = { stage1: Stage1Input; stage2?: Stage2Input };

export type Outcome = "meets" | "not_meets" | "unknown";
export type Evaluation =
  | { status: "incomplete"; missing: string[]; stage2Open: boolean }
  | {
      status: "done";
      result: "meets" | "not_meets" | "undecided";
      stage2Open: boolean;
      /** 読みの組み合わせごとの結果（割れた軸だけで組んだもの。割れなければ 1 つ） */
      outcomes: { combo: Combo; outcome: Outcome }[];
      splits: AxisId[];
      /** 割れた軸ごとの 1 行（定型文と値だけ） */
      lines: string[];
      /** 「分からない」の組み合わせの理由（手入力の欄が空など） */
      reasons: string[];
      /** 門未満の読みのうち、門まであと何回かの小さいほう（門未満の読みがなければ null） */
      remaining: number | null;
    };

export const FIELD_LABEL = {
  gansou: "在宅がん医療総合診療料で訪問した日の回数",
  secondPatient: "同一の患家の 2 人目以降で初診料・再診料を算定した日の回数",
} as const;

type Gate = { kind: "under"; total: number } | { kind: "over" } | { kind: "unknown"; reason: string };

/** 1 段目の門（EM R8-194・R8-195）。乙の回数は甲以上なので、空の欄を除いて数えた数を下限にし、下限が門以上なら門以上と決める（C-334）。特別の関係の機関が分からないときも、自院の数を下限にする */
function gateOf(c: Combo, s: Stage1Input, k: Note14Consts): Gate {
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  const kou = sum(s.months.map((m) => m.kou));
  const wide = readingOf(c, "U-27") === "B";
  const empty: string[] = wide ? (["gansou", "secondPatient"] as const).filter((f) => s[f] === null).map((f) => FIELD_LABEL[f]) : [];
  const own = wide ? kou + sum(s.months.map((m) => m.otsuExtra)) + (s.gansou ?? 0) + (s.secondPatient ?? 0) : kou;
  const included = (i: Institution) => {
    const on = readingOf(c, "U-30b") === "B" && i.ownerChangedFrom ? i.ownerChangedFrom : i.openedOn!;
    return readingOf(c, "U-30a") === "A" ? on > k.excludeOpenedOnOrBefore : on >= k.excludeOpenedOnOrBefore;
  };
  const inst = s.special === "some" ? sum(s.institutions.filter(included).map((i) => i.count)) : 0;
  const total = own + inst;
  if (total >= k.visitThreshold) return { kind: "over" };
  if (s.special === "unknown") return { kind: "unknown", reason: "特別の関係の機関が分からない" };
  if (empty.length > 0) return { kind: "unknown", reason: `手入力の欄が空：${empty.join("・")}` };
  return { kind: "under", total };
}

/** 1 段目の入力の空の欄（結果を出さず名指しする） */
function missingOf(s: Stage1Input): string[] {
  const out: string[] = [];
  for (const m of s.months) {
    if (m.kou === null) out.push(`${m.month} の回数（C001 の行）`);
    if (m.otsuExtra === null) out.push(`${m.month} の回数（C001-2 の行）`);
  }
  if (s.special === "some") {
    if (s.institutions.length === 0) out.push("特別の関係にある機関");
    s.institutions.forEach((i, n) => {
      if (i.openedOn === null) out.push(`特別の関係にある機関 ${n + 1} の開設日`);
      if (i.count === null) out.push(`特別の関係にある機関 ${n + 1} の期間の回数`);
    });
  }
  return out;
}

const RESULT_A: Record<Outcome, string> = { meets: "減算にならず", not_meets: "減算になり", unknown: "分からず" };
const RESULT_B: Record<Outcome, string> = { meets: "減算になりません", not_meets: "減算になります", unknown: "分かりません" };
const wordOf = (set: Set<Outcome>, words: Record<Outcome, string>, mixed: string) => (set.size === 1 ? words[[...set][0]] : mixed);

/** 割れた軸の 1 行（design.md §15-13 の例の形。定型文と値だけ） */
export function splitLine(id: AxisId, a: Set<Outcome>, b: Set<Outcome>): string {
  const x = axisOf(id);
  return `${id}〔${x.label}〕：${x.whenA}${wordOf(a, RESULT_A, "ほかの読み次第で、")}、${x.whenB}${wordOf(b, RESULT_B, "ほかの読み次第です")}。厚生局に確かめてください（照会 #${x.inquiry}）`;
}

/** 読みの全部の組み合わせ（軸ごとに甲・乙） */
const allCombos = (): Combo[] =>
  AXES.reduce<Combo[]>((acc, a) => acc.flatMap((c) => [{ ...c, [a.id]: "A" as const }, { ...c, [a.id]: "B" as const }]), [{}]);
const keyOf = (c: Combo, axes: readonly AxisId[]) => axes.map((a) => readingOf(c, a)).join("");

/** 期間の全部に実績がそろわないか（開設日が期間の初めの月の 1 日より後。U-34） */
const partial = (openedOn: string | null, from: string) => openedOn !== null && openedOn > `${from}-01`;

/** 2 段目の 4 つの要件（EM R8-197〜R8-200）。割合は丸めず整数の不等式で比べる。U-34 の乙では、期間の全部に実績がない要件を満たさない */
function stage2Of(c: Combo, v: Stage2Input, k: Note14Consts, p: Period | null): Outcome {
  const val = (id: FieldId) => v.values[fieldKeyOf(FIELDS.find((f) => f.id === id)!, c)]!;
  const strict = readingOf(c, "U-34") === "B" && p !== null;
  const longGone = strict && partial(v.openedOn, p!.long.from);
  const shortGone = strict && partial(v.openedOn, p!.short.from);
  const referral = !longGone && val("referral") >= k.referralMin;
  const mitori = val("mitoriHome") + (readingOf(c, "U-31a") === "B" ? val("mitoriFacility") : 0) + (readingOf(c, "U-31b") === "B" ? val("mitoriHospital") : 0);
  const care2 = (!longGone && mitori >= k.mitoriMin) || (!shortGone && val("jushoji") >= k.jushojiMin);
  const [c1, c2, c3, c5] = [val("c002"), val("c0022"), val("excluded"), val("care")];
  const ratio3 = !shortGone && (c2 - c3) * k.ratio199.den <= k.ratio199.num * (c1 + c2);
  const ratio4 = !shortGone && c5 * k.ratio200.den >= k.ratio200.num * (c1 + c2);
  return referral && care2 && ratio3 && ratio4 ? "meets" : "not_meets";
}

/** 2 段目の空の欄と、合わない欄（③ が ② より多い・⑤ が ①＋② より多い） */
function missing2Of(v: Stage2Input | undefined): string[] {
  const keys = fieldKeys();
  if (!v) return keys.map((x) => x.label);
  const out = keys.filter((x) => v.values[x.key] === null || v.values[x.key] === undefined).map((x) => x.label);
  if (out.length > 0) return out;
  for (const x of keys) {
    const at = (id: FieldId) => v.values[fieldKeyOf(FIELDS.find((f) => f.id === id)!, x.combo)]!;
    if (x.field.id === "excluded" && at("excluded") > at("c0022")) out.push(`${x.label}（② より多い）`);
    if (x.field.id === "care" && at("care") > at("c002") + at("c0022")) out.push(`${x.label}（① と ② の和より多い）`);
  }
  return out;
}

/** 判定（純関数）。必要な欄が空なら結果を出さず、空の欄を名指しする。period は確認月の期間（U-34 の開設日と比べる） */
export function evaluate(input: WorksheetInput, k: Note14Consts, period: Period | null = null): Evaluation {
  const s = input.stage1;
  const missing = missingOf(s);
  if (missing.length > 0) return { status: "incomplete", missing, stage2Open: false };
  const combos = allCombos();
  const gates = combos.map((c) => gateOf(c, s, k));
  // U-34 は 2 段目の要件だけに掛ける（回数の門は、ある期間の回数で比べる。EM U-34 の補足「門は甲乙で同じ結果になりやすい」）
  const stage2Open = gates.some((g) => g.kind === "over");
  if (stage2Open) {
    const m2 = missing2Of(input.stage2);
    if (m2.length > 0) return { status: "incomplete", missing: m2, stage2Open };
  }
  const outs: Outcome[] = gates.map((g, i) => (g.kind === "under" ? "meets" : g.kind === "over" ? stage2Of(combos[i], input.stage2!, k, period) : "unknown"));
  const reasons = [...new Set(gates.flatMap((g) => (g.kind === "unknown" ? [g.reason] : [])))];
  const remaining = gates.reduce<number | null>((m, g) => (g.kind === "under" ? Math.min(m ?? Infinity, k.visitThreshold - g.total) : m), null);
  return conclude(combos, outs, reasons, remaining, stage2Open);
}

/** 組み合わせごとの結果から、全体の結果・割れた軸・1 行を決める */
function conclude(combos: Combo[], outs: Outcome[], reasons: string[], remaining: number | null, stage2Open: boolean): Extract<Evaluation, { status: "done" }> {
  const at = new Map(combos.map((c, i) => [keyOf(c, AXES.map((a) => a.id)), outs[i]]));
  const ids = AXES.map((a) => a.id);
  const splits = ids.filter((id) => combos.some((c, i) => at.get(keyOf({ ...c, [id]: readingOf(c, id) === "A" ? "B" : "A" }, ids)) !== outs[i]));
  const lines = splits.map((id) => {
    const side = (r: "A" | "B") => new Set(combos.flatMap((c, i) => (readingOf(c, id) === r ? [outs[i]] : [])));
    return splitLine(id, side("A"), side("B"));
  });
  const seen = new Map<string, { combo: Combo; outcome: Outcome }>();
  combos.forEach((c, i) => {
    const key = keyOf(c, splits);
    if (!seen.has(key)) seen.set(key, { combo: Object.fromEntries(splits.map((id) => [id, readingOf(c, id)])) as Combo, outcome: outs[i] });
  });
  const all = new Set(outs);
  const result = all.size === 1 && !all.has("unknown") ? (outs[0] as "meets" | "not_meets") : "undecided";
  return { status: "done", result, stage2Open, outcomes: [...seen.values()], splits, lines, reasons, remaining };
}
