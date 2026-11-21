// G03 行の属性（design.md §12-3）：診療行為のコードが、そのレセプト・その患者・その施設で使えるコードか、医科診療行為マスターの属性で見る。作ったのは 3 つ：
//   入院専用のコード（入外適用区分 1）が入院外のレセプトにある／年齢の上下限が数字で書いてある行で、その行の算定日の年齢でも範囲の外（算定日の分からない単位は、診療年月のあいだのどの年齢でも外）／
//   施設の種別（診療所・病院）が決まっていて、もう一方に限るコード（病院・診療所区分）
// 作っていないもの（素直に作ると正しい請求に出る。点検の範囲に「していない」と出す）：注加算の付け先、実日数を超える回数、診療識別、数字でない年齢の区分（生後の日数など）、後期高齢者医療の区分。
// 施設基準の要る行は指摘にせず、行の名称に「届出が要ります」と添える（src/generic/lookup.ts）
import { pickSnapshot, shinryoOf, type ShinryoRow } from "../masters/db";
import { LATER_NOTE } from "./g02";
import type { TimedClaim } from "./tensuhyo";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericFinding } from "./types";

/** その日の満年齢（誕生日に 1 つ増える数え方） */
const ageOn = (birth: string, y: number, m: number, d: number): number => {
  const by = Number(birth.slice(0, 4));
  const bmd = Number(birth.slice(4));
  return y - by - (m * 100 + d < bmd ? 1 : 0);
};

/**
 * 年齢の幅。day（1〜31）を渡せば、その算定日の年齢：min はその日の満年齢、max は翌日の満年齢（年齢は誕生日の前日に 1 つ増えるという数え方でも、その日までに届く年齢）。
 * day を渡さなければ（算定日の分からない単位）、診療年月のあいだ：min は初日（当月に生まれた患者は生まれた日）の満年齢、max は翌月の初日の満年齢。
 * 生年月日が読めない、または、その日（day がなければ診療年月の末日）より後に生まれた（データの誤り）ときは null（年齢で言わない。round-32 codex-3）
 */
export function agesIn(yearMonth: string, birth: string | undefined, day?: number): { min: number; max: number } | null {
  if (birth === undefined || !/^\d{8}$/.test(birth)) return null;
  const y = Number(yearMonth.slice(0, 4));
  const m = Number(yearMonth.slice(5, 7));
  const to = day ?? new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ymd = (d: number) => y * 10000 + m * 100 + d;
  const b = Number(birth);
  if (b > ymd(to)) return null;
  const from = day ?? (b >= ymd(1) ? b % 100 : 1);
  const next = new Date(Date.UTC(y, m - 1, to + 1));
  return { min: ageOn(birth, y, m, from), max: ageOn(birth, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) };
}

/** 上下限年齢の、数字で書いてある値（00＝制限なし は null。数字でない区分〔AA・B3 など〕も null＝点検しない） */
const limit = (v: string): number | null => (/^\d{2}$/.test(v) && v !== "00" ? Number(v) : null);

/** 行 1 つについて、当たる種類（messageKey の後ろ）と、文に入れる値・当たる単位。年齢は、そのコードのある単位の算定日ごとに見る */
function judge(r: ShinryoRow, about: GenericAboutMore, claim: TimedClaim, units: number[]): { key: string; params: Record<string, string>; units: number[] }[] {
  const out: { key: string; params: Record<string, string>; units: number[] }[] = [];
  if (about.outpatient === true && r.nyugai === "1") out.push({ key: "inpatient_only", params: {}, units });
  if (about.clinic === true && r.hospital_clinic === "1") out.push({ key: "hospital_only", params: {}, units });
  if (about.clinic === false && r.hospital_clinic === "2") out.push({ key: "clinic_only", params: {}, units });
  const lower = limit(r.age_lower);
  const upper = limit(r.age_upper);
  if (lower === null && upper === null) return out;
  // 算定可能な年齢 ≧ 下限年齢、算定可能な年齢 ＜ 上限年齢（［基］p34）。その日に取り得るどの年齢でも外のときだけ
  const outside = (a: { min: number; max: number } | null) => a !== null && ((lower !== null && a.max < lower) || (upper !== null && a.min >= upper));
  const hit = { units: [] as number[], days: new Set<number>(), untimed: false, lo: Infinity, hi: -Infinity };
  for (const i of units) {
    const days = claim.units[i].days;
    const dated = days !== undefined && days.some((n) => n > 0) ? days.slice(0, 31).flatMap((n, d) => (n > 0 ? [d + 1] : [])) : [undefined];
    const ages = dated.map((day) => ({ day, a: agesIn(about.yearMonth, about.birth, day) })).filter((x) => outside(x.a));
    if (ages.length === 0) continue;
    hit.units.push(i);
    for (const { day, a } of ages) {
      if (day === undefined) hit.untimed = true;
      else hit.days.add(day);
      [hit.lo, hit.hi] = [Math.min(hit.lo, a!.min), Math.max(hit.hi, a!.max)];
    }
  }
  if (hit.units.length > 0) {
    const range = [lower !== null ? `${lower} 歳以上` : "", upper !== null ? `${upper} 歳未満` : ""].filter(Boolean).join("・");
    const when = [hit.days.size > 0 ? `算定日（${[...hit.days].sort((x, y) => x - y).join("・")}日）` : "", hit.untimed ? "算定日の分からない単位では診療年月のあいだ" : ""].filter(Boolean).join("、");
    out.push({ key: "age", params: { range, when, ages: hit.lo === hit.hi ? String(hit.lo) : `${hit.lo}〜${hit.hi}` }, units: hit.units });
  }
  return out;
}

/** G03 が点検していないこと（点検の範囲の説明に出す）。前の 1 行は作っていないもの、あとは、その請求について分からないために見ていないもの */
export function g03NotDone(about: GenericAbout): string[] {
  const a = about as GenericAboutMore;
  return [
    "行の属性のうち、注加算の付け先・実日数を超える回数・診療識別・数字でない年齢の区分（生後の日数など）・後期高齢者医療の区分は、点検していません",
    ...(a.outpatient === undefined ? ["入院専用のコードかどうかは、点検していません（入院外のレセプトかどうかが分からないため）"] : []),
    ...(a.birth === undefined ? ["年齢の範囲は、点検していません（生年月日が分からないため）"] : []),
    ...(a.clinic === undefined ? ["病院・診療所の別は、点検していません（施設の種別が設定で決まらないため）"] : []),
  ];
}

export const g03: GenericCheck = {
  id: "G03",
  kind: "行の属性",
  run(claim, masters, about) {
    // コードごとに 1 件（当たる単位をまとめる）
    const seen = new Map<string, number[]>();
    claim.units.forEach((u, i) => {
      for (const it of u.items) if (it.kind === "SI") seen.set(it.code, [...new Set([...(seen.get(it.code) ?? []), i])]);
    });
    if (seen.size === 0) return [];
    const pick = pickSnapshot(masters, "shinryo", about.yearMonth, about.generation);
    if (pick === null) return { skip: `診療年月の世代（${about.generation}）の診療行為のマスターがありません` };
    const end = `${about.yearMonth.replace("-", "")}31`;
    const out: GenericFinding[] = [];
    for (const [code, units] of seen) {
      // マスターにないコードは G01 が言う
      const r = shinryoOf(masters, pick.snapshot, code);
      if (!r) continue;
      // 後の 1 枚で点検していて、その行の変更年月日が診療年月の末日より後なら、条件つき（design.md §12-1）
      const later = pick.later && r.changed_on > end;
      for (const hit of judge(r, about, claim as TimedClaim, units))
        out.push({
          check: "G03",
          kind: "行の属性",
          certainty: later ? "条件つき" : "確定",
          units: hit.units,
          codes: [code],
          messageKey: `G03.${hit.key}`,
          params: { code, name: r.name, ...hit.params, later: later ? LATER_NOTE : "" },
          source: { data: "shinryo", ref: `code=${code}` },
        });
    }
    return out;
  },
};
