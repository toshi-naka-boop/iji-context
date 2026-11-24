// G12 酸素（design.md §19-5。v44 段 22f）：在宅酸素療法指導管理料・酸素療法加算の月の酸素の行、上限を超えた単価、離島等のコード、届け出た単価との違い。
// 酸素の行＝特定器材で酸素の 8 コード（EM §2-8「G・H のコード」）。酸素吸入の行は G05 の背反に任せ、ここでは指摘しない（同じことを 2 回言わない）。
// 使うコード・決まりは EM の行だけ（R8-317・R8-318・R8-330・R8-331。U-73・U-75・U-79）。LLM には判定させない
import { activeOxygenPrices, OXYGEN_CODES, OXYGEN_ISLAND_CODES, oxygenKindOf, oxygenPriceForDates, yenText } from "../facility/oxygen";
import { pickSnapshot, tokuteiOf, type MastersDb } from "../masters/db";
import { LATER_NOTE } from "./g02";
import type { GenericAbout, GenericCheck, GenericClaim, GenericFinding, GenericUnitDetail } from "./types";

/** 在宅酸素療法指導管理料（C103 の 1・2。RY8 C103 (8) は区分を分けない。C-602） */
export const HOME_OXYGEN_KANRI = ["114003710", "114004110"];
/** 酸素療法加算（往診料・訪問診療料(Ⅰ)1・(Ⅱ)イ の加算。R8-331） */
export const OXYGEN_THERAPY_ADDITIONS = ["114042770", "114043670", "114705910"];
/** R8-330 の内側（RY8 C103 (8) の列挙の 8 区分。在宅酸素療法の月は酸素代を算定しない） */
export const R8_330_INSIDE = ["140003810", "140026950", "140005610", "140005750", "140005810", "140005910", "140037810", "140006050"];
/** R8-330 の外側（J201 注1 の範囲から内側を引いた区分：J026-4・J027・J028・J045。在宅酸素療法の月でも酸素代を算定できる） */
export const R8_330_OUTSIDE = [
  "140057310", "140057410", "140057510", "140057610", "140028410",
  "140009310", "140009450", "140009550", "140009650", "140009750", "140009950", "140010050", "140010150", "140023510", "140023650", "140023750", "140023850", "140023950", "140024150", "140024250", "140024350",
  "140039550", "140039650", "140039850", "140039950", "140063310", "140063410", "140063810", "140063950", "140064050", "140064150", "140064250", "140064350", "140064450", "140064550", "140064650", "140064750", "140700770",
];

type Unit = GenericUnitDetail;
const pad = (n: number) => String(n).padStart(2, "0");
/** 単位の算定日（回数が 0 でない日。1 始まり） */
const daysOf = (u: Unit): number[] => (u.days ?? []).flatMap((n, i) => (n > 0 ? [i + 1] : []));
const has = (u: Unit, codes: string[]) => u.items.some((it) => it.kind === "SI" && codes.includes(it.code));
/** 単位の処置の側（内側・外側。どちらでもない処置は数えない） */
const sideOf = (u: Unit): { inside: boolean; outside: boolean } => ({ inside: has(u, R8_330_INSIDE), outside: has(u, R8_330_OUTSIDE) });

/** 単価の欄（UKE のまま）を 0.01 円の整数に。小数第 2 位より細かいものは切らずに null（比べない） */
const centiOfPrice = (text: string | undefined): number | null => {
  const m = text === undefined ? null : /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
};

/**
 * マスターの上限（離島等でないコードの金額。0.01 円の整数）。診療年月の世代の 1 枚がなければ null。
 * later＝後の 1 枚で代えていて、その行の変更年月日が診療年月の末日より後（診療月に効く値か分からない。design.md §12-1。反証 round-94 X-471）
 */
export function limitOf(db: MastersDb, about: GenericAbout, code: string): { centi: number; later: boolean } | null {
  const snap = pickSnapshot(db, "tokutei", about.yearMonth, about.generation);
  const row = snap ? tokuteiOf(db, snap.snapshot, code) : null;
  if (!snap || !row) return null;
  return { centi: Math.round(row.price * 100), later: snap.later && row.changed_on > `${about.yearMonth.replace("-", "")}31` };
}

/**
 * 1. 在宅酸素療法の月の酸素の単位の強さ（design.md §19-5 の 1）。算定日ごとに、同じ単位の処置、なければその日の別の単位の処置に結び付ける。
 * inside＝全部の日が内側だけ／outside＝全部の日が外側だけ／open＝決まらない日がある（days は決まらない日）
 */
function linkOf(units: Unit[], i: number): { side: "inside" | "outside" } | { side: "open"; days: number[] } {
  const u = units[i];
  const days = daysOf(u);
  if (days.length === 0) return { side: "open", days: [] };
  const per = days.map((d) => {
    const own = sideOf(u);
    if (own.inside || own.outside) return own;
    const others = units.filter((x, j) => j !== i && (x.days?.[d - 1] ?? 0) > 0).map(sideOf);
    return { inside: others.some((s) => s.inside), outside: others.some((s) => s.outside) };
  });
  if (per.every((p) => p.inside && !p.outside)) return { side: "inside" };
  if (per.every((p) => p.outside && !p.inside)) return { side: "outside" };
  return { side: "open", days: days.filter((_, k) => !(per[k].inside && !per[k].outside)) };
}

/**
 * 在宅酸素療法の月の、導入より前の日でないと言える事実（design.md §19-5 の 1・§19-13 の 3。G12 の 1 と G05 の HX-25 が同じ事実と条件を使う）：
 * 前の月の同じ患者の請求に管理料が「ある」うえに、days（酸素・酸素吸入の算定日）がすべてその月の管理料の算定日（いちばん早い日）以後。管理料の算定日が分からなければ偽
 */
export function homeOxygenSettled(claim: GenericClaim, about: GenericAbout, days: number[]): boolean {
  const kanri = (claim.units as Unit[]).filter((u) => has(u, HOME_OXYGEN_KANRI));
  if (about.prevHomeOxygen !== "ある" || kanri.length === 0 || days.length === 0 || kanri.some((u) => daysOf(u).length === 0)) return false;
  const first = Math.min(...kanri.flatMap(daysOf));
  return days.every((d) => d >= first);
}

export const g12: GenericCheck = {
  id: "G12",
  kind: "酸素",
  run(claim: GenericClaim, masters: MastersDb, about: GenericAbout) {
    const units = claim.units as Unit[];
    const out: GenericFinding[] = [];
    const finding = (certainty: GenericFinding["certainty"], unit: number, codes: string[], messageKey: string, params: Record<string, string> = {}): GenericFinding => ({
      check: "G12",
      kind: "酸素",
      certainty,
      units: [unit],
      codes,
      messageKey,
      params,
      source: { data: "evidence-master", ref: messageKey.startsWith("G12.home") ? "R8-330" : messageKey === "G12.therapy_addition" ? "R8-331" : messageKey === "G12.island" ? "R8-318" : messageKey === "G12.over_limit" ? "R8-317" : "U-75" },
    });
    const oxygenUnits = units.flatMap((u, i) => (u.items.some((it) => it.kind === "TO" && OXYGEN_CODES.includes(it.code)) ? [i] : []));
    if (oxygenUnits.length === 0) return out;
    const kanriUnits = units.filter((u) => has(u, HOME_OXYGEN_KANRI));
    const addition = units.some((u) => has(u, OXYGEN_THERAPY_ADDITIONS));
    const active = activeOxygenPrices(about.oxygenPrices ?? []);
    const dayText = (days: number[]) => days.map((d) => `${d} 日`).join("・");
    for (const i of oxygenUnits) {
      const u = units[i];
      const codes = [...new Set(u.items.filter((it) => it.kind === "TO" && OXYGEN_CODES.includes(it.code)).map((it) => it.code))];
      // 1. 在宅酸素療法指導管理料の月の酸素
      if (kanriUnits.length > 0) {
        const link = linkOf(units, i);
        if (link.side === "inside") {
          if (homeOxygenSettled(claim, about, daysOf(u))) out.push(finding("確定", i, codes, "G12.home_oxygen"));
          else out.push(finding("条件つき", i, codes, "G12.home_oxygen_intro"));
        } else if (link.side === "open") out.push(finding("条件つき", i, codes, "G12.home_oxygen_unlinked", { days: link.days.length > 0 ? `（結び付かない日・決まらない日：${dayText(link.days)}）` : "（算定日が分かりません）" }));
      }
      // 2. 酸素療法加算の月の酸素
      if (addition) out.push(finding("条件つき", i, codes, "G12.therapy_addition"));
      // 3〜5. 行ごと
      const dates = (daysOf(u).length > 0 ? daysOf(u) : Array.from({ length: 31 }, (_, k) => k + 1)).map((d) => `${about.yearMonth}-${pad(d)}`);
      for (const it of u.items) {
        if (it.kind !== "TO" || !OXYGEN_CODES.includes(it.code)) continue;
        // 4. 離島等のコード（3 と 5 は掛けない）
        if (OXYGEN_ISLAND_CODES.includes(it.code)) {
          out.push(finding("条件つき", i, [it.code], "G12.island"));
          continue;
        }
        const lim = limitOf(masters, about, it.code);
        const limit = lim?.centi ?? null;
        const written = centiOfPrice((it as { unitPrice?: string }).unitPrice);
        // 3. 上限を超えた単価
        if (limit !== null && written !== null && written > limit) {
          // 後の月のマスターの値しかないときは、診療月の上限か分からないので言い切らない（§12-1 と同じ）
          out.push(finding(lim!.later ? "条件つき" : "確定", i, [it.code], "G12.over_limit", { price: yenText(written), limit: yenText(limit), later: lim!.later ? LATER_NOTE : "" }));
          continue;
        }
        // 5. 届け出た単価との違い（単価の欄が書いてある行だけ。空の行は G02 が届け出た単価で検算する。C-584）
        const kind = oxygenKindOf(it.code)!;
        const eff = oxygenPriceForDates(active, kind, dates, limit);
        if (written !== null && eff.priceCenti !== null) {
          const declared = limit !== null ? Math.min(eff.priceCenti, limit) : eff.priceCenti;
          if (written !== declared) out.push(finding("条件つき", i, [it.code], "G12.declared_diff", { declared: yenText(declared), price: yenText(written) }));
        }
      }
    }
    return out;
  },
};

/**
 * 点検の範囲の文（design.md §19-6 の H）。酸素の行があるレセプトだけ。先頭は「見ている場面」
 */
export function g12NotDone(claim: GenericClaim, masters: MastersDb, about: GenericAbout): string[] {
  const units = claim.units as Unit[];
  const oxygen = units.flatMap((u) => u.items.filter((it) => it.kind === "TO" && OXYGEN_CODES.includes(it.code) && !OXYGEN_ISLAND_CODES.includes(it.code)).map((it) => ({ u, it })));
  if (!units.some((u) => u.items.some((it) => it.kind === "TO" && OXYGEN_CODES.includes(it.code)))) return [];
  const out = ["酸素（G12）の見ている場面：在宅酸素療法指導管理料・酸素療法加算の月の酸素、上限を超えた単価、離島等のコード、届け出た単価との違い", "当院は離島等に当たらない前提で、酸素の単価の上限を見ています"];
  const active = activeOxygenPrices(about.oxygenPrices ?? []);
  let none = false;
  let split = false;
  for (const { u, it } of oxygen) {
    const dates = (daysOf(u).length > 0 ? daysOf(u) : Array.from({ length: 31 }, (_, k) => k + 1)).map((d) => `${about.yearMonth}-${pad(d)}`);
    const eff = oxygenPriceForDates(active, oxygenKindOf(it.code)!, dates, limitOf(masters, about, it.code)?.centi ?? null);
    if (eff.split) split = true;
    else if (eff.priceCenti === null) none = true;
  }
  if (none) out.push("酸素の届け出た単価が入っていません。上限だけを見ています");
  if (split) out.push("届け出た単価の期間が、酸素の行の算定日で分かれています。届出との違いは見ていません");
  return out;
}
