// 段 19c・19d（design.md §16-4・16-4-8）を実データの masters.db で：作った症例（テスト用の構造化データ：院内のオーダー＋請求の在医総管の行）で、
// オーダーの院内の日に出る調剤料・処方料・麻薬等加算が、在医総管の月に G04（実データの A35 と包括の表）で隠れ「言わなかったもの」に包括の理由で並ぶ。
// T1〜T6 の「在医総管の月で出ない」を実データで確かめる。RESEMEN_MASTER_DIR があるときだけ動く（ないときは飛ばした数を出す）
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RxOrder, StructuredChart } from "../../src/connect/types";
import { evaluateG11, type G11Claim, type G11Result, type G11Structured } from "../../src/generic/g11";
import { openMasters, type MastersDb } from "../../src/masters/db";
import { withStructured } from "../../src/structured/g11-input";
import type { SItem } from "../../src/structured/overlap";
import { RULE_CODES as R } from "../../src/structured/rule-codes";
import { demoDeclaration, rev, YM } from "../generic/g11-helpers";
import { month } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
let skipped = 0;
const withData = (name: string, fn: () => void) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};
afterAll(() => {
  if (!has) process.stderr.write(`段 19c・19d の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});

/** 在医総管（EM §2-11 表 2 の錨 A34。版の管理料の区分のコード） */
const KANRI = "114032510";
/** ハルシオン０．２５ｍｇ錠（錨 A121。向精神薬）、ゲーベンクリーム１％（錨 A122・A123。外用） */
const HALCION = "611120055";
const GEBEN = "620008991";
const d14 = `${YM}-14`;
const sup = <X,>(items: X[]) => ({ status: "supported" as const, items, gaps: {} });
const UNS = { status: "unsupported" as const };
const days14 = Array.from({ length: 31 }, (_, i) => (i === 13 ? 1 : 0));

function run(db: MastersDb, claim: G11Claim, orders: RxOrder[]): Extract<G11Result, { findings: unknown }> {
  const chart: StructuredChart = { visits: UNS, orders: sup(orders), procedures: UNS, homeCare: UNS };
  const items: SItem[] = orders.flatMap((o) => o.drugs.map((d, i): SItem => ({ part: "orders", kind: "drug", ref: `${o.ref}/${i}`, date: o.date, code: d.code!.value, tbl: "iyakuhin", name: d.name! })));
  const S: G11Structured = {
    chart,
    items,
    history: Array.from({ length: 12 }, (_, i) => ({ yearMonth: month(-(i + 1)), orders: sup<RxOrder>([]), items: [] })),
    lookbackMonths: 12,
    texts: [{ date: d14, text: "定期処方を院内で投薬", soap: "定期処方を院内で投薬", confirmed: true }],
    times: [],
  };
  const r = evaluateG11(
    claim,
    db,
    { yearMonth: YM, generation: rev.generation, acts: withStructured([], { chart, items }, rev).acts, rxDays: [], path: "uke", dispensing: "inside", declaration: demoDeclaration(), outpatient: true, structured: S },
    rev,
  );
  if ("skip" in r) throw new Error(r.skip);
  return r;
}
const order = (ref: string, place: RxOrder["place"], codes: string[]): RxOrder => ({ ref, date: d14, place, refills: null, drugs: codes.map((code) => ({ code: { system: "rece", value: code }, name: `薬 ${code}`, days: 14, quantity: null })) });
const ruleCodes = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.messageKey === "G11.missing_rule").map((f) => f.codes.join("+"));

describe("段 19c：実データで規則の候補と在医総管の月（A35）", () => {
  withData("在医総管のない月は、オーダーの院内の日に調剤料（内服・外用）・処方料（区分なし）・麻薬等加算が出る（T1〜T4 の出る）", () => {
    const db = openMasters(file)!;
    try {
      const r = run(db, { units: [] }, [order("o1", "院内", [HALCION, GEBEN])]);
      expect(ruleCodes(r).sort()).toEqual([R.chozaiOral, R.chozaiExternal, R.shohoryo3, `${R.mayakuChozai}+${R.mayakuShohoryo}`].sort());
    } finally {
      db.close();
    }
  });
  withData("T1〜T4・T5 の在医総管の月で出ない：在医総管の月は、実データの包括（C002001）で隠れ、言わなかったものに包括の理由で並ぶ。T6（注2）は在医総管の月に出る", () => {
    const db = openMasters(file)!;
    try {
      const kanri = { units: [{ items: [{ kind: "SI" as const, code: KANRI }], count: 1, days: days14 }] };
      const r = run(db, kanri, [order("o1", "院内", [HALCION, GEBEN])]);
      expect(ruleCodes(r)).toEqual([rev.codes.C002_N2.primary]);
      const hidden = r.hidden.filter((h) => h.reason === "包括" && h.check === "G04").map((h) => h.written);
      for (const w of ["調剤料（内服薬・浸煎薬・屯服薬）", "調剤料（外用薬）", "処方料", "麻薬等加算（調剤料・処方料）"]) expect(hidden).toContain(w);
      const outside = run(db, kanri, [order("o1", "院外", [HALCION])]);
      expect(ruleCodes(outside)).toEqual([]);
      expect(outside.hidden).toContainEqual(expect.objectContaining({ written: "処方箋料", reason: "包括", check: "G04" }));
    } finally {
      db.close();
    }
  });
});
