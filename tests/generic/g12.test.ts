// G12 酸素と、G02 の届け出た単価（design.md §19-5・§19-6・§19-10 完了条件 7〜9・11。v44 段 22f）。データは同梱しないので、手で作った数行の表で確かめる。
// 表に入れる値は EM の採用値だけ：酸素の上限は R8-317（739220000 0.42・739230000 2.36・739270000 3.15。マスターの金額と一致）。
// EM 5-1 の K32〜K34 は、行の文と正解の件数の承認がまだないので（v44 の実装で止めた点）、症例の fixtures ではなく、ここで単位の組を作って確かめる
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { OxygenPriceRow } from "../../src/facility/oxygen";
import { CERTAIN, evaluateGeneric } from "../../src/generic";
import { g02, recalcClaim } from "../../src/generic/g02";
import { g12 } from "../../src/generic/g12";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAboutMore, GenericClaim, GenericFinding, GenericUnitDetail } from "../../src/generic/types";
import { genericText } from "../../src/messages";
import { YM } from "../helpers/period";
import { GEN, put, smallMasters } from "./small-masters";

const SNAP = `${YM.replace("-", "")}01`;
const KANRI = "114003710";
const KANRI_CYANOSIS = "114004110";
const MATERIAL = "114041610"; // 在宅酸素療法材料加算（その他）
const ADDITION = "114705910"; // 酸素療法加算（往診・在宅ターミナルケア）
const J024 = "140005610";
const J045 = "140009310";
const J045_O2 = "140009650"; // J045 で名前に「酸素吸入」を含むコード（外側）
const J026_4 = "140057410";
const J000 = "140000610";
const SMALL = "739230000";
const LARGE = "739220000";
const SMALL_ISLAND = "739270000";
const RATE = "770020070";

function masters(): Database.Database {
  const db = smallMasters(":memory:", SNAP);
  const plain = { point_kind: "3", kokuji1: "1", nyugai: "0", hospital_clinic: "0", houkatsu_kensa: "0", kizami_kind: "0", age_lower: "00", age_upper: "00", changed_on: "20260601", shisetsu_g1: "0", shisetsu_g2: "0", shisetsu_g3: "0" };
  const exists = (table: string, c: string) => db.prepare(`SELECT 1 FROM ${table} WHERE snapshot = ? AND code = ?`).get(SNAP, c) !== undefined;
  for (const c of [KANRI, KANRI_CYANOSIS, MATERIAL, ADDITION, J024, J045, J045_O2, J026_4, J000]) if (!exists("shinryo", c)) put(db, "shinryo", SNAP, { ...plain, code: c, name: `手作りの行 ${c}`, points: 1 });
  const device = (c: string, price: number, kind: string, sanso: string) => exists("tokutei", c) ? db.prepare("UPDATE tokutei SET price = ?, price_kind = ?, sanso = ? WHERE snapshot = ? AND code = ?").run(price, kind, sanso, SNAP, c) : put(db, "tokutei", SNAP, { code: c, name: `手作りの器材 ${c}`, price_kind: kind, price, sanso, changed_on: "20260601" });
  device(SMALL, 2.36, "1", "5");
  device(LARGE, 0.42, "1", "4");
  device(SMALL_ISLAND, 3.15, "1", "5");
  device(RATE, 30, "5", "1");
  db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G02', 1, '')").run();
  return db;
}

type U = { si?: string[]; to?: { code: string; quantity?: string; price?: string }[]; days: number[]; points?: number };
/** 単位の組の請求。days は算定日（1 始まり） */
function claimOf(...units: U[]): GenericClaim {
  let line = 10;
  const out: GenericUnitDetail[] = units.map((u) => ({
    points: u.points ?? 1,
    count: 1,
    days: Array.from({ length: 31 }, (_, d) => (u.days.includes(d + 1) ? 1 : 0)),
    items: [...(u.si ?? []).map((code) => ({ kind: "SI" as const, code, line: line++, shikibetsu: "", quantity: "" })), ...(u.to ?? []).map((t) => ({ kind: "TO" as const, code: t.code, line: line++, shikibetsu: "", quantity: t.quantity ?? "100", unitPrice: t.price ?? "" }))],
  }));
  return { units: out };
}
const about = (more: Partial<GenericAboutMore> = {}): GenericAboutMore => ({ yearMonth: YM, generation: GEN, outpatient: true, clinic: true, ...more });
const run = (db: Database.Database, c: GenericClaim, a = about()) => g12.run(c, db, a) as GenericFinding[];
const brief = (fs: GenericFinding[]) => fs.map((f) => [f.messageKey, f.certainty]);
const kanriOn = (day: number, code = KANRI): U => ({ si: [code], days: [day] });
const o2 = (price = "1.80"): U["to"] => [{ code: SMALL, price }];
const priceRow = (id: number, kind: OxygenPriceRow["kind"], priceCenti: number, validFrom = "2026-04-01", validUntil = "2027-03-31", revokes: number | null = null): OxygenPriceRow => ({ id, kind, priceCenti, validFrom, validUntil, basis: "前年の購入実績", enteredBy: "x", enteredAt: "x", revokes });

describe("G12 の 1：在宅酸素療法指導管理料の月の酸素（完了条件 7）", () => {
  it("列挙の 8 区分と同じ単位の酸素で、前の月にも管理料があり、酸素の算定日が管理料の算定日以後なら確定（言い切りの一覧に入る）。114004110 の月も同じ", () => {
    const db = masters();
    for (const code of [KANRI, KANRI_CYANOSIS]) {
      const c = claimOf(kanriOn(1, code), { si: [J024], to: o2(), days: [10] });
      expect(brief(run(db, c, about({ prevHomeOxygen: "ある" })))).toEqual([["G12.home_oxygen", "確定"]]);
      const all = evaluateGeneric(c, db, about({ prevHomeOxygen: "ある" })).findings.filter((f) => f.check === "G12");
      expect(all.map((f) => f.certainty)).toEqual(["確定"]);
      expect(CERTAIN.has("G12.home_oxygen")).toBe(true);
    }
  });

  it("前の月の管理料が「ない」「取り込んでいない」（渡さない）なら、条件つきに下がる", () => {
    const db = masters();
    const c = claimOf(kanriOn(1), { si: [J024], to: o2(), days: [10] });
    for (const prev of ["ない", "取り込んでいない", undefined] as const) expect(brief(run(db, c, about({ prevHomeOxygen: prev })))).toEqual([["G12.home_oxygen_intro", "条件つき"]]);
    expect(genericText(run(db, c)[0])).toContain("導入より前の日の処置でなければ");
  });

  it("2 日分の酸素の単位で、1 日は同じ日に J024、もう 1 日は処置がない（又は J045）なら条件つきで、結び付かない日が文に出る。2 日とも J024 なら確定", () => {
    const db = masters();
    const a = about({ prevHomeOxygen: "ある" });
    const none = run(db, claimOf(kanriOn(1), { si: [J024], days: [3] }, { to: o2(), days: [3, 10] }), a);
    expect(brief(none)).toEqual([["G12.home_oxygen_unlinked", "条件つき"]]);
    expect(genericText(none[0])).toContain("10 日");
    const j045 = run(db, claimOf(kanriOn(1), { si: [J024], days: [3] }, { si: [J045], days: [10] }, { to: o2(), days: [3, 10] }), a);
    expect(brief(j045)).toEqual([["G12.home_oxygen_unlinked", "条件つき"]]);
    expect(genericText(j045[0])).toContain("10 日");
    expect(brief(run(db, claimOf(kanriOn(1), { si: [J024], days: [3, 10] }, { to: o2(), days: [3, 10] }), a))).toEqual([["G12.home_oxygen", "確定"]]);
  });

  it("前の月にも管理料があり、その月に中止して 20 日に再び導入した月：3 日の酸素は条件つき、25 日の酸素は確定", () => {
    const db = masters();
    const a = about({ prevHomeOxygen: "ある" });
    expect(brief(run(db, claimOf(kanriOn(20), { si: [J024], to: o2(), days: [3] }), a))).toEqual([["G12.home_oxygen_intro", "条件つき"]]);
    expect(brief(run(db, claimOf(kanriOn(20), { si: [J024], to: o2(), days: [25] }), a))).toEqual([["G12.home_oxygen", "確定"]]);
  });

  it("J045・J026-4・J045 の酸素吸入（マイクロアダプター）と同じ単位の酸素は出さない（列挙の外。C-580・C-592）", () => {
    const db = masters();
    for (const proc of [J045, J026_4, J045_O2]) expect(run(db, claimOf(kanriOn(1), { si: [proc], to: o2(), days: [10] }), about({ prevHomeOxygen: "ある" }))).toEqual([]);
  });

  it("J000 だけと同じ算定日の酸素、処置に結び付かない酸素だけの単位は条件つき（1 件）", () => {
    const db = masters();
    expect(brief(run(db, claimOf(kanriOn(1), { si: [J000], days: [10] }, { to: o2(), days: [10] }), about({ prevHomeOxygen: "ある" })))).toEqual([["G12.home_oxygen_unlinked", "条件つき"]]);
    expect(brief(run(db, claimOf(kanriOn(1), { to: o2(), days: [10] }), about({ prevHomeOxygen: "ある" })))).toEqual([["G12.home_oxygen_unlinked", "条件つき"]]);
  });

  it("在宅酸素療法の材料加算だけの月・在宅酸素療法をしていない患者の酸素では出さない", () => {
    const db = masters();
    expect(run(db, claimOf({ si: [MATERIAL], days: [1] }, { si: [J024], to: o2(), days: [10] }))).toEqual([]);
    expect(run(db, claimOf({ si: [J024], to: o2(), days: [10] }))).toEqual([]);
  });
});

describe("G12 の 2：酸素療法加算の月の酸素（完了条件 7・11）", () => {
  it("酸素療法加算と酸素の行が同じレセプトにあれば条件つきが 1 件（言い切りの一覧に入らない）", () => {
    const db = masters();
    const c = claimOf({ si: [ADDITION], days: [20] }, { si: [J024], to: o2(), days: [20] });
    expect(brief(run(db, c))).toEqual([["G12.therapy_addition", "条件つき"]]);
    expect(evaluateGeneric(c, db, about()).findings.filter((f) => f.check === "G12").map((f) => f.certainty)).toEqual(["条件つき"]);
  });
});

describe("G12 の 3・4・5：単価（完了条件 8・11）", () => {
  it("上限を超えた単価は確定が 1 件で、文の頭に「当院が離島等に当たらない前提」", () => {
    const db = masters();
    const c = claimOf({ si: [J024], to: o2("2.50"), days: [10] });
    const fs = evaluateGeneric(c, db, about()).findings.filter((f) => f.check === "G12");
    expect(fs.map((f) => [f.messageKey, f.certainty])).toEqual([["G12.over_limit", "確定"]]);
    expect(genericText(fs[0])).toMatch(/^当院が離島等に当たらない前提で、酸素の単価 2\.50 円\/L が上限 2\.36 円\/L を超えています/);
  });

  it("離島等のコードは条件つき（確かめる）が 1 件で、上限の確定は出ない", () => {
    const db = masters();
    expect(brief(run(db, claimOf({ si: [J024], to: [{ code: SMALL_ISLAND, price: "9.99" }], days: [10] })))).toEqual([["G12.island", "条件つき"]]);
  });

  it("届け出た単価がなければ 5 は出ず、点検の範囲に「上限だけを見ています」。届け出た単価と違えば条件つき、同じなら出ない", () => {
    const db = masters();
    const c = claimOf({ si: [J024], to: o2("2.00"), days: [10] });
    expect(run(db, c)).toEqual([]);
    const r0 = evaluateGeneric(c, db, about());
    expect(genericScopeOf(c, db, about(), r0).notDone).toContain("酸素の届け出た単価が入っていません。上限だけを見ています");
    expect(genericScopeOf(c, db, about(), r0).notDone).toContain("当院は離島等に当たらない前提で、酸素の単価の上限を見ています");
    const declared = about({ oxygenPrices: [priceRow(1, "small", 180)] });
    const diff = run(db, c, declared);
    expect(brief(diff)).toEqual([["G12.declared_diff", "条件つき"]]);
    expect(genericText(diff[0])).toContain("届け出た単価 1.80 円/L と違います");
    expect(run(db, claimOf({ si: [J024], to: o2("1.80"), days: [10] }), declared)).toEqual([]);
    const r1 = evaluateGeneric(c, db, declared);
    expect(genericScopeOf(c, db, declared, r1).notDone).not.toContain("酸素の届け出た単価が入っていません。上限だけを見ています");
    // 取り消した届出は使わない
    expect(run(db, c, about({ oxygenPrices: [priceRow(1, "small", 180), priceRow(2, "small", 180, "2026-04-01", "2027-03-31", 1)] }))).toEqual([]);
  });

  it("上限を超えて届け出た単価は上限として比べる。算定日で期間が分かれる単位では 5 を出さず、点検の範囲の文が出る", () => {
    const db = masters();
    expect(run(db, claimOf({ si: [J024], to: o2("2.36"), days: [10] }), about({ oxygenPrices: [priceRow(1, "small", 300)] }))).toEqual([]);
    const split = about({ oxygenPrices: [priceRow(1, "small", 180, "2026-04-01", "2026-10-15"), priceRow(2, "small", 200, "2026-10-16", "2027-03-31")] });
    const c = claimOf({ si: [J024], days: [3, 20] }, { to: o2("2.10"), days: [3, 20] });
    expect(run(db, c, split)).toEqual([]);
    expect(genericScopeOf(c, db, split, evaluateGeneric(c, db, split)).notDone).toContain("届け出た単価の期間が、酸素の行の算定日で分かれています。届出との違いは見ていません");
  });
});

describe("G02 と届け出た単価（完了条件 9・11）", () => {
  // 大型ボンベ 100 L × 1.3：単価 0.40 円 → 52 円 → 5 点、0.30 円 → 39 円 → 4 点（式は R8-315・R8-319・R8-326。錨 F25・F26）
  const unit = (points: number): U => ({ si: [], to: [{ code: LARGE, quantity: "100", price: "" }, { code: RATE, quantity: "" }], days: [10], points });

  it("単価の欄が空の酸素の行は、届け出た単価がなければ購入価格で対象外、あれば検算する。不一致は条件つきで、式の名前に「届け出た単価で」", () => {
    const db = masters();
    const c = claimOf(unit(5));
    expect(recalcClaim(c, db, about())).toMatchObject([{ status: "excluded", reason: "purchase" }]);
    const declared = about({ oxygenPrices: [priceRow(1, "large", 40)] });
    expect(recalcClaim(c, db, declared)).toMatchObject([{ status: "match", declared: true }]);
    const bad = claimOf(unit(9));
    const fs = g02.run(bad, db, declared) as GenericFinding[];
    expect(fs.map((f) => [f.messageKey, f.certainty, f.params.formula])).toEqual([["G02.points_declared", "条件つき", "特定器材料（届け出た単価で。価格 × 使用量 ÷ 10 円を四捨五入）"]]);
    expect(evaluateGeneric(bad, db, declared, undefined, new Set([...CERTAIN, "G02.points"])).findings.filter((f) => f.check === "G02").map((f) => f.certainty)).toEqual(["条件つき"]);
    // 単価の欄が空の行には、届け出た単価があっても G12 の 5 は出ない（C-584）
    expect(run(db, c, declared)).toEqual([]);
  });

  it("届け出た単価が上限を超えていれば、上限の額で検算する", () => {
    const db = masters();
    // 0.42 円 × 100 L × 1.3 ＝ 54.6 円 → 55 円 → 6 点（届け出た 0.50 円ではなく上限）
    expect(recalcClaim(claimOf(unit(6)), db, about({ oxygenPrices: [priceRow(1, "large", 50)] }))).toMatchObject([{ status: "match", declared: true }]);
  });
});
