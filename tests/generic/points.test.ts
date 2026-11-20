// 段 11：G02（点数の検算）・G03（行の属性）。データは同梱しないので、手で作った数行の表で確かめる（実データでの確認は tests/generic/points-real.test.ts）。
// 表に入れるのは EM に採用済みのコードと値だけ：診療行為の点数は版の点数表（EM §2-2）と EM §2-11 の錨（A07〜A15・A75）、特定器材は錨 A23〜A27・A79・A81。
// 医薬品の金額は、薬価ではなく手で決めた値（式の錨 F10・F11 が成り立つ範囲の数。公開元の値を写していない）
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import { evaluateGeneric } from "../../src/generic";
import { g02, recalcClaim, recalcSummary } from "../../src/generic/g02";
import { agesIn, g03, g03NotDone } from "../../src/generic/g03";
import { rowNamesOf } from "../../src/generic/lookup";
import { drugPoints, EXCLUDE_TEXT, kizamiCenti, recalcUnit, type RecalcItem } from "../../src/generic/points";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAboutMore, GenericClaim, GenericUnitDetail } from "../../src/generic/types";
import { parseEm, verifyMasters } from "../../src/masters/verify";
import { GENERIC_TEXT, genericText } from "../../src/messages";
import { YM } from "../helpers/period";
import { DEVICE, DRUG, GEN, put, smallMasters } from "./small-masters";

const SNAP = `${YM.replace("-", "")}01`;
const about: GenericAboutMore = { yearMonth: YM, generation: GEN, outpatient: true, birth: "19500615", clinic: true };
const code = (kubun: string) => r2026.codes[kubun].primary;
const pts = (kubun: string) => r2026.points[kubun].points;
const HOUMON = code("C001_1I");
const OUSHIN = code("C000");
const KINKYU = code("C000_N1_KINKYU");
const JINSOKU = code("D_GAIRAI_JINSOKU");
// EM §2-11 の錨のコード
const GENOME = "160216450"; // F03：41,500 点＝この検査 − 2,500 点
const GENOME_MINUS = "160231970"; // A75：点数（マイナス）2,500
const PERCENT = "140000190"; // A14：％加算 40
const POST_OP_HOSPITAL = "113004510"; // A09：1,188 点、入院、病院
const POST_OP_CLINIC = "113004610"; // A10：1,056 点、入院、診療所
const INFANT = "111000370"; // A07：75 点、6 歳未満
const ASTHMA_65 = "113018210"; // A08：入院外、65 歳以上
const KEFLEX = "620004981"; // F10：6 カプセルで 19 点
const GASTER = "610406079"; // F11：0.4 g で 1 点
const FILM_INFANT = "799990070"; // A24：％加算 10
const OXYGEN = "739220000"; // A79：酸素ボンベ・大型
const OXYGEN_RATE = "770020070"; // A25：％加算 30
const IRIDIUM = "770050000"; // A27：購入価格
const MEMBERS = r2026.bundles[0].members;

/** 手作りの表。G02・G03 の準備ができていることにする */
function masters(snapshot = SNAP): Database.Database {
  const db = smallMasters(":memory:", snapshot);
  const set = (c: string, row: Record<string, string | number>) => db.prepare(`UPDATE shinryo SET ${Object.keys(row).map((k) => `${k} = ?`).join(", ")} WHERE code = ?`).run(...Object.values(row), c);
  const plain = { point_kind: "3", kokuji1: "1", nyugai: "0", hospital_clinic: "0", houkatsu_kensa: "0", kizami_kind: "0", age_lower: "00", age_upper: "00", changed_on: "20260601", shisetsu: "" };
  for (const kubun of Object.keys(r2026.codes)) set(code(kubun), { ...plain, points: pts(kubun) });
  set(KINKYU, { kokuji1: "7" });
  set(JINSOKU, { kizami_kind: "1", kizami_lower: 1, kizami_upper: 5, kizami_step: 1, kizami_points: 10, kizami_error: "1", alpha: "D", kubun_no: 0 });
  set(code("C001_N13_DX"), { shisetsu: "4100" });
  const add = (c: string, row: Record<string, string | number>) => put(db, "shinryo", snapshot, { ...plain, code: c, name: `手作りの行 ${c}`, ...row });
  add(GENOME, { points: 44000 });
  add(GENOME_MINUS, { point_kind: "8", points: 2500, kokuji1: "7" });
  add(PERCENT, { point_kind: "5", points: 40, kokuji1: "9" });
  add(POST_OP_HOSPITAL, { points: 1188, nyugai: "1", hospital_clinic: "1" });
  add(POST_OP_CLINIC, { points: 1056, nyugai: "1", hospital_clinic: "2" });
  add(INFANT, { points: 75, kokuji1: "7", age_upper: "06" });
  add(ASTHMA_65, { nyugai: "2", age_lower: "65" });
  for (const m of MEMBERS.slice(0, 6)) add(m, { houkatsu_kensa: "1" });
  db.prepare("UPDATE iyakuhin SET price_kind = '7', changed_on = '20260401' WHERE code = ?").run(DRUG);
  put(db, "iyakuhin", snapshot, { code: KEFLEX, name: "手作りの医薬品 1", price_kind: "1", price: 31, changed_on: "20260401" });
  put(db, "iyakuhin", snapshot, { code: GASTER, name: "手作りの医薬品 2", price_kind: "1", price: 10, changed_on: "20260401" });
  db.prepare("UPDATE tokutei SET price_kind = '1', price = 62, sanso = '0', changed_on = '20260601' WHERE code = ?").run(DEVICE);
  const device = (c: string, row: Record<string, string | number>) => put(db, "tokutei", snapshot, { code: c, name: `手作りの器材 ${c}`, sanso: "0", changed_on: "20260601", ...row });
  device(FILM_INFANT, { price_kind: "5", price: 10 });
  device(OXYGEN, { price_kind: "1", price: 0.42, sanso: "4" });
  device(OXYGEN_RATE, { price_kind: "5", price: 30, sanso: "1" });
  device(IRIDIUM, { price_kind: "2", price: 0 });
  db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason, missing) VALUES ('G02', 1, '', '[]'), ('G03', 1, '', '[]')").run();
  return db;
}

const snaps = { SI: SNAP, IY: SNAP, TO: SNAP };
const si = (c: string, quantity = ""): RecalcItem => ({ kind: "SI", code: c, quantity });
const iy = (c: string, quantity: string): RecalcItem => ({ kind: "IY", code: c, quantity });
const to = (c: string, quantity = "", unitPrice = ""): RecalcItem => ({ kind: "TO", code: c, quantity, unitPrice });
const bundles = r2026.bundles.map((b) => ({ members: b.members, tiers: b.tiers.map((t) => ({ min: t.min, points: pts(t.kubun) })) }));
const calc = (db: Database.Database, items: RecalcItem[], shikibetsu = "", more: { shikibetsuSure?: boolean; commented?: boolean; count?: number } = {}) => {
  const r = recalcUnit(db, snaps, items, { shikibetsu, shikibetsuSure: true, bundles, ...more });
  return "points" in r ? r.points : r.reason;
};
/** UKE の単位の形の請求。行番号は、単位の並びのとおりに振る */
function claimOf(...units: { items: RecalcItem[]; points: number; shikibetsu?: string; count?: number }[]): GenericClaim {
  let line = 10;
  const out: GenericUnitDetail[] = units.map((u) => ({ points: u.points, count: u.count ?? 1, days: [1], items: u.items.map((it, i) => ({ ...it, line: line++, shikibetsu: i === 0 ? (u.shikibetsu ?? "") : "" })) }));
  return { units: out };
}

describe("検算の式（src/generic/points.ts）", () => {
  it("薬剤料：15 円以下は 1 点（投薬・注射）か算定しない（ほかの区分）。15 円を超えたら、（薬価 − 15 円）÷ 10 円を切り上げて 1 点を足す", () => {
    expect([15, 15.01, 25, 25.01, 189, 3.8].map((y) => drugPoints(y, "one"))).toEqual([1, 2, 2, 3, 19, 1]);
    expect([15, 15.01, 25, 25.01, 0.92 * 40].map((y) => drugPoints(y, "none"))).toEqual([0, 2, 2, 3, 4]);
    // 小数の誤差で境目をまたがない（0.1 円 × 150 ＝ 15 円ちょうど）
    expect(drugPoints(0.1 * 150, "one")).toBe(1);
    expect(drugPoints(0.1 * 250, "one")).toBe(2);
  });

  it("きざみ：数量が下限値以下なら基本点数、超えたら きざみ値ごとに切り上げて足す。上限を超えた数量は、上下限エラー処理が 1・3 なら上限値で止める", () => {
    // 外来迅速検体検査加算（EM §2-11 A15）：1 項目ごとに 10 点、5 項目まで
    const row = { points: 10, kizami_lower: 1, kizami_upper: 5, kizami_step: 1, kizami_points: 10, kizami_error: "1" };
    expect([1, 2, 5, 6, 9].map((n) => kizamiCenti(row, n))).toEqual([1000, 2000, 5000, 5000, 5000]);
    expect(kizamiCenti({ ...row, kizami_error: "0" }, 6)).toBe(6000);
    // 30 分又はその端数ごと（下限 90・きざみ 30・基本 100）：70 分は基本点数、91 分は 200 点。60 分以下は、エラー処理 2 なら算定しない
    const time = { points: 100, kizami_lower: 90, kizami_upper: 99999999, kizami_step: 30, kizami_points: 100, kizami_error: "2" };
    expect([61, 70, 90, 91, 120, 121].map((n) => kizamiCenti(time, n))).toEqual([10000, 10000, 10000, 20000, 20000, 30000]);
    expect(kizamiCenti(time, 60)).toBeNull();
    expect(kizamiCenti({ ...time, kizami_error: "0" }, 60)).toBe(10000);
  });

  it("診療行為：点数の合算（基本項目＋注加算）、点数（マイナス）は引く、きざみは数量から", () => {
    const db = masters();
    expect(calc(db, [si(HOUMON)])).toBe(pts("C001_1I"));
    // 往診料＋緊急往診加算（EM §2-11 A03・A04）
    expect(calc(db, [si(OUSHIN), si(KINKYU)])).toBe(pts("C000") + pts("C000_N1_KINKYU"));
    expect(calc(db, [si(GENOME), si(GENOME_MINUS)])).toBe(41500);
    expect(calc(db, [si(JINSOKU, "3")])).toBe(30);
  });

  it("診療行為：再計算できない形は、理由つきで対象外にする（合っているとは言わない）", () => {
    const db = masters();
    expect(calc(db, [si(OUSHIN), si(PERCENT)])).toBe("percent");
    expect(calc(db, [si("100000000")])).toBe("notInMaster");
    expect(calc(db, [si(JINSOKU)])).toBe("quantity");
    expect(calc(db, [si(JINSOKU, "3")], "", { commented: true })).toBe("commented");
    // 同じ区分番号のきざみの行が 2 つ
    expect(calc(db, [si(JINSOKU, "2"), si(JINSOKU, "1")])).toBe("kizamiCombined");
    expect(calc(db, [si(HOUMON), iy(KEFLEX, "6")])).toBe("mixed");
    // きざみでない行の点数に端数がある
    db.prepare("UPDATE shinryo SET points = 42.5 WHERE code = ?").run(GENOME);
    expect(calc(db, [si(GENOME)])).toBe("fraction");
  });

  it("包括の検査：版の表にある群だけ。項目数が区分に届けばその点数、届かなければ項目の点数の合算。表にない群・ほかの行と同じ単位は対象外", () => {
    const db = masters();
    const tier = bundles[0].tiers[0];
    expect(calc(db, MEMBERS.slice(0, tier.min).map((m) => si(m)))).toBe(tier.points);
    expect(calc(db, MEMBERS.slice(0, tier.min - 1).map((m) => si(m)))).toBe(0);
    expect(calc(db, [...MEMBERS.slice(0, tier.min).map((m) => si(m)), si(HOUMON)])).toBe("bundleMixed");
    db.prepare("UPDATE shinryo SET houkatsu_kensa = '2' WHERE code = ?").run(GENOME);
    expect(calc(db, [si(GENOME)])).toBe("bundleNoTable");
  });

  it("薬剤料：単位の薬価を合算してから。診療識別で式を決め、決まらなければ対象外", () => {
    const db = masters();
    expect(calc(db, [iy(KEFLEX, "6")], "21")).toBe(19);
    expect(calc(db, [iy(GASTER, "0.4")], "21")).toBe(1);
    expect(calc(db, [iy(GASTER, "0.4")], "40")).toBe(0);
    expect(calc(db, [iy(KEFLEX, "1"), iy(GASTER, "1")], "33")).toBe(4);
    expect(calc(db, [iy(KEFLEX, "6")], "")).toBe("shikibetsu");
    expect(calc(db, [iy(KEFLEX, "6")], "13")).toBe("shikibetsu");
    // 15 円以下で、診療識別の引き継ぎが確かでないとき
    expect(calc(db, [iy(GASTER, "0.4")], "21", { shikibetsuSure: false })).toBe("shikibetsu");
    expect(calc(db, [iy(KEFLEX, "6")], "21", { shikibetsuSure: false })).toBe(19);
    expect(calc(db, [iy(KEFLEX, "")], "21")).toBe("quantity");
    expect(calc(db, [iy(DRUG, "")], "21")).toBe("amount");
    expect(calc(db, [iy(KEFLEX, "6")], "21", { commented: true })).toBe("commented");
    expect(calc(db, [iy(KEFLEX, "0.01")], "60", { count: 21 })).toBe("perCount");
    expect(calc(db, [iy(KEFLEX, "6")], "60")).toBe(19);
  });

  it("特定器材料：価格 × 使用量 ÷ 10 円を四捨五入。％加算は直前の器材に掛ける。酸素は書いてある単価で。購入価格は対象外", () => {
    const db = masters();
    // 四ツ切 62 円（EM §2-11 A23）
    expect(calc(db, [to(DEVICE, "1")])).toBe(6);
    expect(calc(db, [to(DEVICE, "4")])).toBe(25);
    expect(calc(db, [to(DEVICE, "1", "62")])).toBe(6);
    expect(calc(db, [to(DEVICE, "1", "70")])).toBe("purchase");
    // フィルム料（乳幼児）加算（F24）：62 円 × 1.1 ＝ 68.2 円 → 7 点
    expect(calc(db, [to(DEVICE, "1"), to(FILM_INFANT)])).toBe(7);
    expect(calc(db, [to(FILM_INFANT)])).toBe("deviceRate");
    // 酸素（F25）：0.30 円 × 300 L × 1.3 ＝ 117 円 → 12 点。単価がない・上限を超える単価は対象外
    expect(calc(db, [to(OXYGEN, "300", "0.30"), to(OXYGEN_RATE)])).toBe(12);
    expect(calc(db, [to(OXYGEN, "300"), to(OXYGEN_RATE)])).toBe("purchase");
    expect(calc(db, [to(OXYGEN, "300", "0.50"), to(OXYGEN_RATE)])).toBe("purchase");
    expect(calc(db, [to(IRIDIUM, "1", "10000")])).toBe("purchase");
    expect(calc(db, [to(DEVICE, "")])).toBe("quantity");
    // ％加算の器材で、円で丸めるかどうかで点数が変わるとき（62 円 × 12 枚 × 1.1 ＝ 818.4 円は変わらない。62 円 × 4 枚 × 1.1 ＝ 272.8 円も変わらない）
    expect(calc(db, [to(DEVICE, "4"), to(FILM_INFANT)])).toBe(27);
  });
});

describe("G02 点数の検算", () => {
  const good = () =>
    claimOf(
      { items: [si(HOUMON)], points: pts("C001_1I"), shikibetsu: "14" },
      { items: [si(OUSHIN), si(KINKYU)], points: pts("C000") + pts("C000_N1_KINKYU"), shikibetsu: "14" },
      { items: [iy(KEFLEX, "6")], points: 19, shikibetsu: "21" },
      { items: [to(DEVICE, "1")], points: 6, shikibetsu: "70" },
      { items: [si(OUSHIN), si(PERCENT)], points: 1008 },
    );

  it("合っている請求には何も言わない。再計算できない単位は「検算の対象外」に数え、合っているとは数えない", () => {
    const db = masters();
    expect(g02.run(good(), db, about)).toEqual([]);
    const list = recalcClaim(good(), db, about);
    expect(Array.isArray(list) && list.map((r) => r.status)).toEqual(["match", "match", "match", "match", "excluded"]);
    expect(recalcSummary(Array.isArray(list) ? list : [])).toEqual({ units: 5, checked: 4, matched: 4, excluded: [{ reason: "percent", text: EXCLUDE_TEXT.percent, count: 1 }] });
  });

  it("点数・数量を変えた単位だけが出る。指摘は、UKE の点数・再計算した点数・式の種類を持つ", () => {
    const db = masters();
    const bad = good();
    (bad.units[1] as GenericUnitDetail).points = 1400;
    (bad.units[2] as GenericUnitDetail).items[0].quantity = "7";
    const found = g02.run(bad, db, about);
    expect(Array.isArray(found) && found.map((f) => [f.units, f.codes, f.params.uke, f.params.calc])).toEqual([
      [[1], [OUSHIN, KINKYU], "1400", "1370"],
      [[2], [KEFLEX], "19", "22"],
    ]);
    const f = (found as Exclude<typeof found, { skip: string }>)[0];
    expect(f).toMatchObject({ check: "G02", kind: "点数", certainty: "確定", messageKey: "G02.points", source: { data: "shinryo", ref: `code=${OUSHIN}, code=${KINKYU}` } });
    expect(genericText(f)).toBe("この単位の 1 回分の点数が、マスターからの再計算と合いません（UKE は 1400 点、再計算は 1370 点。診療行為の点数の合算）。コード・数量・点数を確かめてください");
    expect(GENERIC_TEXT["G02.points"]).toBeDefined();
  });

  it("言い切りの一覧が空なので、出るのは条件つき。一覧に載れば確定", () => {
    const db = masters();
    const bad = good();
    (bad.units[0] as GenericUnitDetail).points = 1;
    expect(evaluateGeneric(bad, db, about).findings.map((f) => [f.check, f.certainty])).toEqual([["G02", "条件つき"]]);
    expect(evaluateGeneric(bad, db, about, [g02], new Set(["G02.points"])).findings.map((f) => f.certainty)).toEqual(["確定"]);
  });

  it("後の 1 枚で点検していて、使った行の変更年月日が診療年月の末日より後なら、一覧に載っていても条件つき＋「この後にマスターが変更されています」", () => {
    // 診療年月より後の更新日の 1 枚しか持っていない
    const later = `${String(Number(YM.slice(0, 4)) + 1)}0101`;
    const db = masters(later);
    const bad = good();
    (bad.units[0] as GenericUnitDetail).points = 1;
    (bad.units[1] as GenericUnitDetail).points = 1;
    db.prepare("UPDATE shinryo SET changed_on = ? WHERE code = ?").run(later, HOUMON);
    const found = evaluateGeneric(bad, db, about, [g02], new Set(["G02.points"])).findings;
    expect(found.map((f) => [f.units[0], f.certainty, f.params.later])).toEqual([
      [0, "条件つき", "。この後にマスターが変更されています"],
      [1, "確定", ""],
    ]);
    expect(genericText(found[0])).toMatch(/確かめてください。この後にマスターが変更されています$/);
  });

  it("診療識別は、省略された単位では前の行のものを引き継ぐ。15 円以下の薬剤は、あいだにコメントレコードがあれば決めない", () => {
    const db = masters();
    const claim = claimOf({ items: [si(HOUMON)], points: pts("C001_1I"), shikibetsu: "33" }, { items: [iy(GASTER, "0.4")], points: 1 }, { items: [iy(KEFLEX, "6")], points: 19 });
    expect((recalcClaim(claim, db, about) as { status: string }[]).map((r) => r.status)).toEqual(["match", "match", "match"]);
    // 2 つめの単位（行番号 11）の前にコメントレコード（行のない行番号）は置けないので、単位のあいだを空けて置く
    const spaced = claimOf({ items: [si(HOUMON)], points: pts("C001_1I"), shikibetsu: "33" }, { items: [iy(GASTER, "0.4")], points: 1 });
    (spaced.units[1] as GenericUnitDetail).items[0].line = 20;
    const withCo = { ...spaced, comments: [{ line: 15, code: "810000001", raw: "", unit: null }] };
    expect(recalcClaim(withCo, db, about)).toMatchObject([{ status: "match" }, { status: "excluded", reason: "commented" }]);
  });

  it("同じ群の包括の検査が、同じ日の 2 つの単位に分かれていれば対象外。点数のない単位（区分キーから作った単位）は数えない", () => {
    const db = masters();
    const split = claimOf({ items: MEMBERS.slice(0, 3).map((m) => si(m)), points: 0 }, { items: MEMBERS.slice(3, 6).map((m) => si(m)), points: 0 });
    expect(recalcClaim(split, db, about)).toMatchObject([{ status: "excluded", reason: "bundleSplit" }, { status: "excluded", reason: "bundleSplit" }]);
    expect(recalcClaim({ units: [{ items: [{ kind: "SI", code: HOUMON }] }] }, db, about)).toEqual([]);
  });

  it("診療年月の世代のマスターがなければ、動かさない（近い世代で代用しない）", () => {
    expect(g02.run(good(), masters(), { yearMonth: YM, generation: "R6" })).toMatchObject({ skip: expect.stringMatching(/マスターがありません/) });
  });
});

describe("G03 行の属性", () => {
  const claim = (...codes: string[]): GenericClaim => ({ units: codes.map((c) => ({ items: [{ kind: "SI" as const, code: c }] })) });
  const keys = (db: Database.Database, c: GenericClaim, a: GenericAboutMore) => (g03.run(c, db, a) as { messageKey: string; codes: string[] }[]).map((f) => [f.messageKey, f.codes[0]]);

  it("正しい請求には何も言わない", () => {
    expect(g03.run(claim(HOUMON, OUSHIN, code("C001_N13_DX")), masters(), about)).toEqual([]);
  });

  it("入院専用のコードが入院外のレセプトにある／病院に限るコードが診療所にある（その行だけ）", () => {
    const db = masters();
    expect(keys(db, claim(HOUMON, POST_OP_CLINIC), about)).toEqual([["G03.inpatient_only", POST_OP_CLINIC]]);
    expect(keys(db, claim(HOUMON, POST_OP_HOSPITAL), about)).toEqual([["G03.inpatient_only", POST_OP_HOSPITAL], ["G03.hospital_only", POST_OP_HOSPITAL]]);
    // 病院なら、診療所に限るコード
    expect(keys(db, claim(POST_OP_CLINIC), { ...about, outpatient: false, clinic: false })).toEqual([["G03.clinic_only", POST_OP_CLINIC]]);
    const f = (g03.run(claim(POST_OP_CLINIC), db, about) as { messageKey: string; params: Record<string, string> }[])[0];
    expect(genericText(f)).toBe(`コード ${POST_OP_CLINIC}（手作りの行 ${POST_OP_CLINIC}）は、マスターでは入院のレセプトに限るコードです。入院外のレセプトで算定できるか、告示・通知を確かめてください`);
  });

  it("年齢：上下限が数字の行で、診療年月の初日・末日のどちらの年齢でも範囲の外のときだけ", () => {
    const db = masters();
    const y = Number(YM.slice(0, 4));
    const m = YM.slice(5, 7);
    const born = (age: number, day: string) => `${y - age}${day}`;
    // 6 歳未満の加算：月の途中で 6 歳になる患者には言わない。月の初日にもう 6 歳なら言う
    expect(keys(db, claim(INFANT), { ...about, birth: born(6, `${m}15`) })).toEqual([]);
    expect(keys(db, claim(INFANT), { ...about, birth: born(6, `${m}01`) })).toEqual([["G03.age", INFANT]]);
    expect(keys(db, claim(INFANT), { ...about, birth: born(3, "0101") })).toEqual([]);
    // 65 歳以上：月の末日に 65 歳になる患者・翌月の 1 日が誕生日の患者（前日に年齢が増える数え方）には言わない
    const next = m === "12" ? "0101" : `${String(Number(m) + 1).padStart(2, "0")}01`;
    expect(keys(db, claim(ASTHMA_65), { ...about, birth: `${m === "12" ? y + 1 - 65 : y - 65}${next}` })).toEqual([]);
    expect(keys(db, claim(ASTHMA_65), { ...about, birth: born(64, "0101") })).toEqual([["G03.age", ASTHMA_65]]);
    const forty: GenericAboutMore = { ...about, birth: born(40, "0101") };
    const f = (g03.run(claim(ASTHMA_65), db, forty) as { messageKey: string; params: Record<string, string> }[])[0];
    expect(f.params).toMatchObject({ range: "65 歳以上", ageFrom: "40", ageTo: "40" });
    expect(genericText(f)).toMatch(/年齢の範囲（65 歳以上）の外です（診療年月の初日は 40 歳、末日は 40 歳）/);
    // 数字でない年齢の区分（生後の日数など）は、点検しない
    db.prepare("UPDATE shinryo SET age_upper = 'AA' WHERE code = ?").run(INFANT);
    expect(keys(db, claim(INFANT), about)).toEqual([]);
    expect(agesIn(YM, "x")).toBeNull();
  });

  it("分からない項目に依る点検はしない。していないことを、点検の範囲に出す", () => {
    const db = masters();
    const bare = { yearMonth: YM, generation: GEN };
    expect(g03.run(claim(POST_OP_HOSPITAL, INFANT), db, bare)).toEqual([]);
    expect(g03NotDone(bare)).toHaveLength(4);
    expect(g03NotDone(about)).toEqual(["行の属性のうち、注加算の付け先・実日数を超える回数・診療識別・数字でない年齢の区分（生後の日数など）・後期高齢者医療の区分は、点検していません"]);
  });

  it("後の 1 枚で点検していて、その行の変更年月日が診療年月の末日より後なら、条件つき＋断り書き", () => {
    const later = `${String(Number(YM.slice(0, 4)) + 1)}0101`;
    const db = masters(later);
    db.prepare("UPDATE shinryo SET changed_on = ? WHERE code = ?").run(later, POST_OP_CLINIC);
    const found = evaluateGeneric(claim(POST_OP_CLINIC, POST_OP_HOSPITAL), db, about, [g03], new Set(["G03.inpatient_only", "G03.hospital_only"])).findings;
    expect(found.map((f) => [f.codes[0], f.messageKey, f.certainty, f.params.later !== ""])).toEqual([
      [POST_OP_CLINIC, "G03.inpatient_only", "条件つき", true],
      [POST_OP_HOSPITAL, "G03.inpatient_only", "確定", false],
      [POST_OP_HOSPITAL, "G03.hospital_only", "確定", false],
    ]);
  });

  it("施設基準のある行は、指摘にせず、名称に「届出が要ります」の印を付ける（G03 の準備ができている masters.db のときだけ）", () => {
    const db = masters();
    const dx = code("C001_N13_DX");
    const items = [{ kind: "SI" as const, code: dx }, { kind: "SI" as const, code: HOUMON }];
    const names = rowNamesOf(db, about, { items, comments: [], diseases: [] });
    expect([names.items[dx].todokede, names.items[HOUMON].todokede]).toEqual([true, undefined]);
    expect(g03.run(claim(dx), db, about)).toEqual([]);
    db.prepare("UPDATE checks_ready SET ready = 0 WHERE check_id = 'G03'").run();
    expect(rowNamesOf(db, about, { items, comments: [], diseases: [] }).items[dx].todokede).toBeUndefined();
  });
});

describe("点検の範囲（src/generic/scope.ts）", () => {
  it("検算の数と対象外の理由、していないことを返す。点数のない行（入力した行）では、検算していないと返す", () => {
    const db = masters();
    const claim = claimOf({ items: [si(HOUMON)], points: pts("C001_1I") }, { items: [si(OUSHIN), si(PERCENT)], points: 1008 });
    const scope = genericScopeOf(claim, db, about, evaluateGeneric(claim, db, about));
    expect(scope.recalc).toEqual({ units: 2, checked: 1, matched: 1, excluded: [{ reason: "percent", text: EXCLUDE_TEXT.percent, count: 1 }] });
    expect(scope.notDone).toHaveLength(1);
    const lines: GenericClaim = { units: [{ items: [{ kind: "SI", code: HOUMON }] }] };
    const bare = { yearMonth: YM, generation: GEN };
    const s2 = genericScopeOf(lines, db, bare, evaluateGeneric(lines, db, bare));
    expect(s2.recalc).toBeUndefined();
    expect(s2.notDone[0]).toMatch(/点数が書いていないので、検算していません/);
    expect(s2.notDone).toHaveLength(5);
    // 点検が動いていなければ、何も足さない
    expect(genericScopeOf(lines, null, bare, evaluateGeneric(lines, null, bare))).toEqual({ notDone: [] });
  });
});

describe("式の錨（EM §2-11 表 2-2）", () => {
  const EM = (rows: string[]) => ["### 2-8. 採用した診療行為コード", "", "### 2-11. 採用したデータ源", "", "| 錨 | 診療識別 | 行 | 点数 | 意味 | 原文で確かめた箇所 |", "|---|---|---|---|---|---|", ...rows, "", "### 2-12. 次"].join("\n");
  const F = (id: string, shikibetsu: string, items: string, points: number) => `| ${id} | ${shikibetsu} | \`${items}\` | ${points} | 意味 | 原文 |`;

  it("行を読む：種類:コード*数量@単価。形が違えば例外", () => {
    const em = parseEm(EM([F("F10", "21", `IY:${KEFLEX}*6`, 19), F("F25", "—", `TO:${OXYGEN}*300@0.30 TO:${OXYGEN_RATE}`, 12)]));
    expect(em.formulas).toEqual([
      { id: "F10", shikibetsu: "21", items: [{ kind: "IY", code: KEFLEX, quantity: "6" }], points: 19 },
      { id: "F25", shikibetsu: "", items: [{ kind: "TO", code: OXYGEN, quantity: "300", unitPrice: "0.30" }, { kind: "TO", code: OXYGEN_RATE }], points: 12 },
    ]);
    expect(() => parseEm(EM([F("F10", "21", "IY:123", 19)]))).toThrow(/式の錨 F10/);
    expect(() => parseEm(EM([F("F10", "21", `IY:${KEFLEX}*6 TO:${DEVICE}*1`, 19)]))).toThrow(/式の錨 F10/);
    expect(() => parseEm(EM([F("F10", "21", `IY:${KEFLEX}*6`, 19), F("F10", "21", `IY:${KEFLEX}*6`, 19)]))).toThrow(/番号が重複/);
  });

  it("再計算が原文の点数にならなければ失敗。医薬品の式の錨が通れば、薬価の読み方（G02 の準備）が満たされる", () => {
    const run = (rows: string[]) => {
      const db = masters();
      return verifyMasters(db, parseEm(EM(rows)), { write: false, revisions: [] });
    };
    const ok = run([F("F10", "21", `IY:${KEFLEX}*6`, 19), F("F24", "—", `TO:${DEVICE}*1 TO:${FILM_INFANT}`, 7)]);
    expect(ok.failures).toBe(0);
    expect(ok.lines).toContain("式の錨：2 個のうち 2 個が通った");
    expect(ok.ready.find((r) => r.check === "G02")!.missing).not.toContain("iyakuhin:price_kind=1, price");
    const off = run([F("F10", "21", `IY:${KEFLEX}*6`, 20), F("F11", "13", `IY:${GASTER}*0.4`, 1)]);
    expect(off.failures).toBe(2);
    expect(off.lines.filter((l) => l.startsWith("式の錨 F"))).toEqual([expect.stringMatching(/F10 が外れた.*原文は 20 点、再計算は 19 点/), expect.stringMatching(/F11 が外れた.*再計算は できない（shikibetsu）/)]);
    expect(off.ready.find((r) => r.check === "G02")!.missing).toContain("iyakuhin:price_kind=1, price");
  });
});
