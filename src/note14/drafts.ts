// 注14 の計算の道具の 2 段目の下書き（design.md §15-13。段 17k）：取り込んだ請求の行と患者の事実から、①②③⑤ を読みの組み合わせごとの欄に入れる。
// 患者の数え方（round-57 X-173・round-58 X-180・round-59 C-341。L-146・L-158）：期間の実人数は同定の鍵（氏名・生年月日・性別）、月ごとの延べは同定の鍵＋診療年月（種別は外す）。
// 同じ月のレセプトの鍵（種別を含む）が 2 つ以上のレセプトで重なる月があれば、自動で数えない（1 段目と同じく手入力に案内する）。
// 鍵はメモリの中だけで作り、戻り値には数だけを返す。下書きは本人が直す（本人が直した欄は出どころが手入力になる）
import type { UkePatient } from "../uke/types";
import { identityKey, sameMonthKey } from "./count";
import { fieldKeyOf, FIELDS, type Combo, type FieldId } from "./readings";

/** 下書きに使うレセプト 1 枚：管理料の族（在医総管＝C002・施設総管＝C002-2）と、除く患者に当たる行（在宅ターミナルケア加算・看取り加算・死亡診断加算）があるか */
export type DraftReceipt = { yearMonth: string; patient: UkePatient; families: ("在医総管" | "施設総管")[]; excluded: boolean };

export type Draft =
  | { ok: true; values: Record<string, number>; unknownCare: number }
  | { ok: false; reason: string };

export const DRAFT_TEXT = {
  overlap: (months: string[]) => `${months.join("・")} は同じ月のレセプトが重なっているので、2 段目の下書きを作りません。数を入れてください`,
  missing: (months: string[]) => `${months.join("・")} は取り込みがないか、版の行で読めないので、2 段目の下書きを作りません。数を入れてください`,
  unknownCare: (n: number) => `要介護度・別表第八の二の状態が未入力 ${n} 人（下書きの数に入れていません）。認知症の自立度・障害支援区分で当たる患者は、事実にないので足してください`,
} as const;

/**
 * 下書き（純関数）。months は期間の 3 か月、careOf は患者の事実から要介護 3 以上又は別表第八の二に当たるか（true）・当たらない（false）・未入力（null）。
 * ③ は ② の患者のうち除く患者、⑤ は ①・② の患者のうち当たる患者（認知症の自立度・障害支援区分は事実にないので数えない。本人が足す）
 */
export function draftOf(receipts: DraftReceipt[], months: string[], careOf: (p: DraftReceipt["patient"]) => boolean | null): Draft {
  const mine = receipts.filter((r) => months.includes(r.yearMonth));
  const empty = months.filter((m) => !mine.some((r) => r.yearMonth === m));
  if (empty.length > 0) return { ok: false, reason: DRAFT_TEXT.missing(empty) };
  const overlap = months.filter((m) => {
    const keys = mine.filter((r) => r.yearMonth === m).map((r) => sameMonthKey(r.patient, m));
    return new Set(keys).size !== keys.length;
  });
  if (overlap.length > 0) return { ok: false, reason: DRAFT_TEXT.overlap(overlap) };

  // 延べ：同定の鍵＋診療年月（種別は外す）ごとに、その月の族と除く行
  type Cell = { id: string; month: string; families: Set<string>; excluded: boolean; patient: DraftReceipt["patient"] };
  const cells = new Map<string, Cell>();
  for (const r of mine) {
    const id = identityKey(r.patient);
    const key = `${id}|${r.yearMonth}`;
    const c = cells.get(key) ?? { id, month: r.yearMonth, families: new Set<string>(), excluded: false, patient: r.patient };
    for (const f of r.families) c.families.add(f);
    c.excluded ||= r.excluded;
    cells.set(key, c);
  }
  const all = [...cells.values()];
  const side = (c: Cell): "c002" | "c0022" | null => (c.families.has("施設総管") ? "c0022" : c.families.has("在医総管") ? "c002" : null);
  const months2 = all.filter((c) => side(c) !== null);
  // 実人数：同定の鍵ごとに、最後に算定した月の側に 1 回だけ（U-33a の読み甲）
  const people = new Map<string, Cell>();
  for (const c of [...months2].sort((a, b) => a.month.localeCompare(b.month))) people.set(c.id, c);
  const everExcluded = new Set(all.filter((c) => c.excluded).map((c) => c.id));
  const care = new Map<string, boolean | null>();
  const careOfId = (c: Cell) => {
    if (!care.has(c.id)) care.set(c.id, careOf(c.patient));
    return care.get(c.id)!;
  };

  const values: Record<string, number> = {};
  const put = (id: FieldId, combo: Combo, n: number) => (values[fieldKeyOf(FIELDS.find((f) => f.id === id)!, combo)] = n);
  const real = [...people.values()];
  for (const [u, list] of [["A", real], ["B", months2]] as const) {
    const of = (s: "c002" | "c0022") => list.filter((c) => side(c) === s);
    put("c002", { "U-33a": u }, of("c002").length);
    put("c0022", { "U-33a": u }, of("c0022").length);
    // ③：甲＝期間中に 1 回でも除く患者に当たれば除く、乙＝算定した月（実人数は最後に算定した月）の分だけ
    put("excluded", { "U-33a": u, "U-33b": "A" }, of("c0022").filter((c) => everExcluded.has(c.id)).length);
    put("excluded", { "U-33a": u, "U-33b": "B" }, of("c0022").filter((c) => c.excluded).length);
    // ⑤：事実は月ごとに持たないので、どちらの読みも同じ事実で数える（本人が直す）
    const n5 = list.filter((c) => careOfId(c) === true).length;
    put("care", { "U-33a": u, "U-33c": "A" }, n5);
    put("care", { "U-33a": u, "U-33c": "B" }, n5);
  }
  const unknownCare = real.filter((c) => careOfId(c) === null).length;
  return { ok: true, values, unknownCare };
}
