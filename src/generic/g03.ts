// G03 行の属性（design.md §12-3）：診療行為のコードが、そのレセプト・その患者・その施設で使えるコードか、医科診療行為マスターの属性で見る。作ったのは 3 つ：
//   入院専用のコード（入外適用区分 1）が入院外のレセプトにある／年齢の上下限が数字で書いてある行で、診療年月の初日・末日のどちらの年齢でも範囲の外／
//   施設の種別（診療所・病院）が決まっていて、もう一方に限るコード（病院・診療所区分）
// 作っていないもの（素直に作ると正しい請求に出る。点検の範囲に「していない」と出す）：注加算の付け先、実日数を超える回数、診療識別、数字でない年齢の区分（生後の日数など）、後期高齢者医療の区分。
// 施設基準の要る行は指摘にせず、行の名称に「届出が要ります」と添える（src/generic/lookup.ts）
import { pickSnapshot, shinryoOf, type ShinryoRow } from "../masters/db";
import { LATER_NOTE } from "./g02";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericFinding } from "./types";

/** その日の満年齢（誕生日に 1 つ増える数え方） */
const ageOn = (birth: string, y: number, m: number, d: number): number => {
  const by = Number(birth.slice(0, 4));
  const bmd = Number(birth.slice(4));
  return y - by - (m * 100 + d < bmd ? 1 : 0);
};

/**
 * 診療年月のあいだに取り得る年齢の幅。min は初日の満年齢、max は翌月の初日の満年齢（年齢は誕生日の前日に 1 つ増えるという数え方でも、末日までに届く年齢）。
 * 表示用に、末日の満年齢（last）も返す。生年月日が読めなければ null
 */
export function agesIn(yearMonth: string, birth: string | undefined): { min: number; max: number; last: number } | null {
  if (birth === undefined || !/^\d{8}$/.test(birth)) return null;
  const y = Number(yearMonth.slice(0, 4));
  const m = Number(yearMonth.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const min = ageOn(birth, y, m, 1);
  // 診療年月より後に生まれた（生年月日の誤り）は、年齢で言わない
  return min < 0 ? null : { min, max: ageOn(birth, ny, nm, 1), last: ageOn(birth, y, m, lastDay) };
}

/** 上下限年齢の、数字で書いてある値（00＝制限なし は null。数字でない区分〔AA・B3 など〕も null＝点検しない） */
const limit = (v: string): number | null => (/^\d{2}$/.test(v) && v !== "00" ? Number(v) : null);

/** 行 1 つについて、当たる種類（messageKey の後ろ）と、文に入れる値 */
function judge(r: ShinryoRow, about: GenericAboutMore): { key: string; params: Record<string, string> }[] {
  const out: { key: string; params: Record<string, string> }[] = [];
  if (about.outpatient === true && r.nyugai === "1") out.push({ key: "inpatient_only", params: {} });
  if (about.clinic === true && r.hospital_clinic === "1") out.push({ key: "hospital_only", params: {} });
  if (about.clinic === false && r.hospital_clinic === "2") out.push({ key: "clinic_only", params: {} });
  const ages = agesIn(about.yearMonth, about.birth);
  const lower = limit(r.age_lower);
  const upper = limit(r.age_upper);
  // 算定可能な年齢 ≧ 下限年齢、算定可能な年齢 ＜ 上限年齢（［基］p34）。月のあいだに取り得るどの年齢でも外のときだけ
  if (ages && ((lower !== null && ages.max < lower) || (upper !== null && ages.min >= upper))) {
    const range = [lower !== null ? `${lower} 歳以上` : "", upper !== null ? `${upper} 歳未満` : ""].filter(Boolean).join("・");
    out.push({ key: "age", params: { range, ageFrom: String(ages.min), ageTo: String(ages.last) } });
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
      for (const hit of judge(r, about))
        out.push({
          check: "G03",
          kind: "行の属性",
          certainty: later ? "条件つき" : "確定",
          units,
          codes: [code],
          messageKey: `G03.${hit.key}`,
          params: { code, name: r.name, ...hit.params, later: later ? LATER_NOTE : "" },
          source: { data: "shinryo", ref: `code=${code}` },
        });
    }
    return out;
  },
};
