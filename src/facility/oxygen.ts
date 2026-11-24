// 届け出た酸素の単価（design.md §19-3。v44 段 22e）：施設の値で、採用値ではない（spec FR-201）。区分・単価（0.01 円）・適用の始めと終わり・届出の元。
// 点検（G12・G02。src/generic/g12.ts・g02.ts）は、この表の構造化した値だけを読む（院内の知識の文章から取り出さない）。
// 区分と特定器材のコード・上限は EM §2-8「G・H のコード」と §2-15（R8-317・R8-320）

/** 区分（R8-320）。CE＝定置式液化酸素貯槽、LGC＝可搬式液化酸素容器、large＝大型ボンベ（3,000 L を超える）、small＝小型ボンベ（3,000 L 以下） */
export const OXYGEN_KINDS = ["CE", "LGC", "large", "small"] as const;
export type OxygenKind = (typeof OXYGEN_KINDS)[number];
export const OXYGEN_KIND_TEXT: Record<OxygenKind, string> = { CE: "CE（定置式液化酸素貯槽）", LGC: "LGC（可搬式液化酸素容器）", large: "大型ボンベ", small: "小型ボンベ" };
/** 区分 → 特定器材マスターの酸素等区分（2〜5） */
export const OXYGEN_SANSO: Record<OxygenKind, string> = { CE: "2", LGC: "3", large: "4", small: "5" };
/** 区分 → 離島等でないコード（マスターの金額が上限。R8-317） */
export const OXYGEN_CODE: Record<OxygenKind, string> = { CE: "739200000", LGC: "739210000", large: "739220000", small: "739230000" };
/** 離島等のコード（R8-318。当院が離島等に当たらない前提〔U-73〕なので、出たら確かめる） */
export const OXYGEN_ISLAND_CODES = ["739240000", "739250000", "739260000", "739270000"];
/** 酸素のコード（8 つ） */
export const OXYGEN_CODES = [...Object.values(OXYGEN_CODE), ...OXYGEN_ISLAND_CODES];
/** コード → 区分 */
export const oxygenKindOf = (code: string): OxygenKind | null => {
  const i = OXYGEN_CODES.indexOf(code);
  return i < 0 ? null : OXYGEN_KINDS[i % 4];
};
/** 届出の元（R8-316・R8-321） */
export const OXYGEN_BASES = ["前年の購入実績", "前年の実績なし", "30% を超える変動の随時の届出"] as const;
export type OxygenBasis = (typeof OXYGEN_BASES)[number];

/** 表の 1 行。revokes は取り消しの行だけが持つ（取り消した行の id） */
export type OxygenPriceRow = { id: number; kind: OxygenKind; priceCenti: number; validFrom: string; validUntil: string; basis: OxygenBasis; enteredBy: string; enteredAt: string; revokes: number | null };

/** 取り消されていない行（取り消しの行そのものも除く） */
export function activeOxygenPrices(rows: OxygenPriceRow[]): OxygenPriceRow[] {
  const revoked = new Set(rows.flatMap((r) => (r.revokes !== null ? [r.revokes] : [])));
  return rows.filter((r) => r.revokes === null && !revoked.has(r.id));
}

/** その日に効く、届け出た単価（0.01 円の整数）。期間に入る行が 2 つ以上あれば、後に入れた行（id の大きい方）。なければ null */
export function oxygenPriceOn(active: OxygenPriceRow[], kind: OxygenKind, date: string): number | null {
  const hit = active.filter((r) => r.kind === kind && r.validFrom <= date && date <= r.validUntil).sort((a, b) => b.id - a.id)[0];
  return hit ? hit.priceCenti : null;
}

/**
 * 単位の算定日（YYYY-MM-DD の並び）に効く単価。全部の日で同じ単価なら split は偽で priceCenti にその値、
 * 日によって違う・期間に入らない日がある単位は split が真（届出との比べをしない。design.md §19-3）。どの日にも効く行がなければ priceCenti は null
 */
export function oxygenPriceForDates(active: OxygenPriceRow[], kind: OxygenKind, dates: string[]): { priceCenti: number | null; split: boolean } {
  const prices = dates.map((d) => oxygenPriceOn(active, kind, d));
  if (prices.every((p) => p === null)) return { priceCenti: null, split: false };
  const first = prices[0];
  return prices.every((p) => p === first) ? { priceCenti: first, split: false } : { priceCenti: null, split: true };
}

/** そのクリニックの今日（デモの時計）が属する年度の 4 月 1 日と翌年の 3 月 31 日（入力の初期値。R8-315 の年度） */
export function fiscalYearOf(today: string): { validFrom: string; validUntil: string } {
  const y = Number(today.slice(0, 4));
  const start = Number(today.slice(5, 7)) >= 4 ? y : y - 1;
  return { validFrom: `${start}-04-01`, validUntil: `${start + 1}-03-31` };
}

/** 単価の文字（小数第 2 位まで、0 より大きい）を 0.01 円の整数に。形が違えば null */
export function centiOf(text: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return v > 0 ? v : null;
}

/** 0.01 円の整数を「0.30」の形に */
export const yenText = (centi: number): string => `${Math.floor(centi / 100)}.${String(centi % 100).padStart(2, "0")}`;
