// 実在の請求と同じ形の UKE を読めること：記録条件仕様（医科用）令和8年8月版のレコードの種類の全部、仕様の桁数（回数・算定日情報 3 桁、
// 商品名 300 バイト、症状詳記 2,400 バイト）、入院・臓器提供・知らないレコードのレセプトをレセプト単位で読めないものにすること。
// 検証用の合成の UKE（fixtures/uke/jitsurei.UKE。EM 5-1 の表）の読み取りもここ
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateJitsurei, JITSUREI, loadSources } from "../../scripts/gen-uke";
import { resolveRevision } from "../../src/engine/revisions";
import { UKE_LIMITS } from "../../src/uke/limits";
import { mapClaim, parseUke, readStoredUke, readUke, UkeError, UNREADABLE } from "../../src/uke/uke";
import { uploadClaimIdOf } from "../../src/uke/upload";
import { YM } from "../helpers/period";

const root = path.join(__dirname, "..", "..");
const jitsurei = readFileSync(path.join(root, JITSUREI.file));
const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
const rowsOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1)).slice(0, -2).split("\r\n");
const ukeOf = (rows: string[]) => enc(`${rows.join("\r\n")}\r\n`);
/** n 項目のレコード（1 起算の項目番号 → 値） */
const rec = (n: number, cols: Record<number, string | number>) => {
  const out: string[] = Array.from({ length: n }, () => "");
  for (const [k, v] of Object.entries(cols)) out[Number(k) - 1] = String(v);
  return out.join(",");
};
/** jitsurei の rows の、最初に pattern に当たる行の後ろに extra を入れる */
const insertAfter = (rows: string[], pattern: RegExp, extra: string[], from = 0) => {
  const i = rows.findIndex((l, n) => n >= from && pattern.test(l));
  return [...rows.slice(0, i + 1), ...extra, ...rows.slice(i + 1)];
};
const ym = YM.replace("-", "");
const rev = resolveRevision(YM);
const reasonOf = (buf: Buffer): [number | null, string] => {
  try {
    readUke(buf);
  } catch (e) {
    if (e instanceof UkeError) return [e.line, e.reason];
    throw e;
  }
  throw new Error("読めてしまった");
};

/** GO の総件数を 1 つ増やす */
const bumpGo = (go: string) => go.replace(/^GO,(\d+),/, (_, n: string) => `GO,${Number(n) + 1},`);

describe("レコードの種類（記録条件仕様 令和8年8月版 p1〜2 の表）", () => {
  /** 臓器提供者のレセプト情報（TI・TR・TS と、提供者の SY・SI・SJ。提供者の SI は算定日情報を省略できる。仕様 p17・p21〜23） */
  const donor = [
    rec(10, { 1: "TI", 2: 1, 3: 2, 4: "13", 5: 1, 6: "9999998", 8: "架空病院", 9: "東京都架空区" }),
    rec(18, { 1: "TR", 2: 1, 3: "1992", 4: ym, 6: 1, 7: "19700101" }),
    rec(5, { 1: "TS", 2: 1, 3: 100 }),
    "SY,0000999,20260101,1,,架空の病名,,",
    rec(44, { 1: "SI", 2: "60", 3: 1, 4: "160008010", 6: 100, 7: 1 }),
    "SJ,90,提供者の症状詳記",
  ];
  /** jitsurei の 1 件目に公費（KO・公費の SN・JD）と GR を、最後のレセプトに臓器提供者のレセプト情報を足したもの */
  const all = () => {
    let rows = rowsOf(jitsurei);
    rows = insertAfter(rows, /^HO,/, [rec(12, { 1: "KO", 2: "12139992", 3: "0000018", 5: 2, 6: 845 })]);
    rows = insertAfter(rows, /^SN,/, ["SN,2,01,,,,,,"]);
    rows = insertAfter(rows, /^JD,/, [rows.find((l) => l.startsWith("JD,"))!.replace(/^JD,1,/, "JD,2,")]);
    rows = insertAfter(rows, /^MF,/, ["GR,09,010010XX9909XX"]);
    // KO を 1 つ足したので、GO の総件数（HO と KO の数の合計。記録条件仕様 GO の注）も 1 つ増やす
    return [...rows.slice(0, -1), ...donor, bumpGo(rows[rows.length - 1])];
  };
  const KINDS = ["IR", "RE", "HO", "KO", "SN", "JD", "MF", "GR", "SY", "SI", "IY", "TO", "CO", "SJ", "TI", "TR", "TS", "GO"];

  it("(a) 18 種のレコードの全部を含む UKE を、「未対応のレコード」で断らない。SN・JD・MF・GR・SJ・HO の診療実日数は読んで持つ", () => {
    const rows = all();
    expect([...new Set(rows.map((l) => l.slice(0, 2)))].sort()).toEqual([...KINDS].sort());
    const parsed = parseUke(ukeOf(rows));
    const [first, second, , last] = parsed.claims;
    expect(first.eligibility).toEqual([{ payerKind: "1", confirmation: "01" }, { payerKind: "2", confirmation: "01" }]);
    expect(first.visits.map((v) => [v.payerKind, v.days.flatMap((n, i) => (n ? [[i + 1, n]] : []))])).toEqual([["1", [[15, 1], [29, 1]]], ["2", [[15, 1], [29, 1]]]]);
    expect([first.copay, first.dpcExclusions, first.realDays, first.kohiTotals]).toEqual([["00"], [{ reason: "09", dpcCode: "010010XX9909XX" }], 2, [845]]);
    // 受診等区分 2（診療実日数に計上しない受診）も読む。症状詳記は、区分を省略した行が前の行の区分を継ぐ
    expect(second.visits[0].days.flatMap((n, i) => (n ? [[i + 1, n]] : []))).toEqual([[28, 1], [30, 2]]);
    expect(second.realDays).toBe(1);
    expect(second.notes.map((n) => n.kind)).toEqual(["03", "03"]);
    expect(second.notes[0].text).toMatch(/^合成の症状詳記です。/);
    // 臓器提供者のレセプト情報が付いたレセプトは、そのレセプトだけが読めない。提供者の行は、受容者の行に混ぜない
    expect([last.unsupported, last.units, last.comments]).toEqual([UNREADABLE.donor, [], []]);
    const file = readUke(ukeOf(rows), uploadClaimIdOf(1));
    expect(file.receipts.map((r) => [r.claimId, r.unreadable?.reason ?? null, r.lines.length > 0])).toEqual([["U1-1", null, true], ["U1-2", null, true], ["U1-3", null, true], ["U1-4", UNREADABLE.donor, false]]);
    expect(file.receipts[3].declared).toEqual({ ho: 8350, ko: [] });
    expect(readStoredUke(ukeOf(rows), uploadClaimIdOf(1))).toEqual(file);
  });

  it("1 種ずつ：どのレコードを足しても「未対応のレコード」にならない。項目数が違えば、そのレコードの行番号で断る", () => {
    const one: Record<string, string> = {
      KO: rec(12, { 1: "KO", 2: "12139992", 3: "0000018", 5: 2, 6: 845 }),
      SN: "SN,2,01,,,,,,",
      JD: rec(33, { 1: "JD", 2: 2, 17: 1 }),
      MF: rec(33, { 1: "MF", 2: "00" }),
      GR: "GR,09,010010XX9909XX",
      SJ: "SJ,01,合成の症状詳記",
      TI: donor[0],
      TR: donor[1],
      TS: donor[2],
    };
    for (const [kind, row] of Object.entries(one)) {
      // KO は HO の直後、ほかは SY の手前（TI・TR・TS は、その後ろのレコードを読まないので場所によらない）
      const added = insertAfter(rowsOf(jitsurei), kind === "KO" ? /^HO,/ : /^MF,/, [row]);
      // KO は GO の総件数に入る（HO と KO の数の合計）
      const rows = kind === "KO" ? [...added.slice(0, -1), bumpGo(added[added.length - 1])] : added;
      expect(() => readUke(ukeOf(rows)), kind).not.toThrow();
      const line = rows.indexOf(row) + 1;
      expect(reasonOf(ukeOf(rows.map((l) => (l === row ? `${l},` : l)))), kind).toEqual([line, "列数が合わない"]);
    }
    for (const row of ["SN,9,01,,,,,,", "SN,1,1,,,,,,", rec(33, { 1: "JD", 2: 1, 3: "x" }), rec(33, { 1: "MF", 2: "0" }), "GR,9,", "SJ,1,文"]) {
      expect(reasonOf(ukeOf(insertAfter(rowsOf(jitsurei), /^MF,/, [row])))[1], row).toMatch(/の形が違う$/);
    }
  });

  it("入院のレセプト（レセプト種別の 4 桁目が奇数）は、断らずにそのレセプトだけを読めないものにする。食事療養の行（金額・数量つき）があっても、同じファイルの入院外のレセプトは読む", () => {
    const rows = rowsOf(jitsurei);
    const second = rows.findIndex((l) => l.startsWith("RE,2,"));
    rows[second] = rows[second].replace(/^RE,2,1118,/, "RE,2,1117,");
    const meal = rec(44, { 1: "SI", 2: "97", 3: 1, 4: "197000110", 5: 3, 6: 2190, 7: 3, [14 + 27]: 1, [14 + 28]: 1, [14 + 29]: 1 });
    const buf = ukeOf(insertAfter(rows, /^SI,/, [meal], second));
    const parsed = parseUke(buf);
    expect([parsed.claims[1].unsupported, parsed.claims[1].units, parsed.claims[1].total?.points]).toEqual([UNREADABLE.inpatient, [], 919]);
    const file = readUke(buf, uploadClaimIdOf(3));
    expect(file.receipts.map((r) => r.unreadable?.reason ?? null)).toEqual([null, UNREADABLE.inpatient, null, null]);
    expect(file.receipts[1]).toMatchObject({ claimId: "U3-2", lines: [], comments: [], declared: { ho: 919, ko: [] } });
    expect(file.receipts[0].lines.length).toBeGreaterThan(0);
  });

  it("仕様にないレコード（DPC のレコードなど。識別情報は英大文字 2 字）は、ファイルを断らずに、そのレセプトだけを読めないものにする。項目数は確かめない", () => {
    const buf = ukeOf(insertAfter(rowsOf(jitsurei), /^MF,/, ["BU,010010XX9909XX,20261001,,,", "CD,20261001,60,1,1,160008010,1,,,"]));
    expect(readUke(buf, uploadClaimIdOf(1)).receipts.map((r) => r.unreadable?.reason ?? null)).toEqual([UNREADABLE.record, null, null, null]);
    // RE より前の、知らないレコードは断る
    expect(reasonOf(ukeOf(insertAfter(rowsOf(jitsurei), /^IR,/, ["BU,x"])))).toEqual([2, "RE より前に BU がある"]);
  });
});

describe("回数と上限（記録条件仕様 p16〜20）", () => {
  it("(b) 投薬：処方した日の欄に 7・14・28 が入った IY の単位を読める（手引き p53・p60〜62 の記録例の形）。回数と 1 日の回数は 3 桁（999）まで", () => {
    const iy = (days: Record<number, number>, points: number | "") =>
      rec(44, { 1: "IY", 2: "21", 3: 1, 4: "620491801", 5: "0.5", 6: points, 7: Object.values(days).reduce((s, n) => s + n, 0), ...Object.fromEntries(Object.entries(days).map(([d, n]) => [13 + Number(d), n])) });
    const rows = insertAfter(rowsOf(jitsurei), /^SI,/, [iy({ 1: 7, 8: 14, 22: 28 }, ""), iy({ 1: 7, 8: 14, 22: 28 }, 0), iy({ 31: 999 }, 0)]);
    const units = parseUke(ukeOf(rows)).claims[0].units;
    expect(units.slice(1, 3).map((u) => [u.items.map((x) => [x.kind, x.quantity]), u.count, u.days.flatMap((n, i) => (n ? [[i + 1, n]] : []))])).toEqual([
      [[["IY", "0.5"], ["IY", "0.5"]], 49, [[1, 7], [8, 14], [22, 28]]],
      [[["IY", "0.5"]], 999, [[31, 999]]],
    ]);
    expect(() => readUke(ukeOf(rows))).not.toThrow();
    // 同梱の検証用の UKE にも、14 日分 × 2 回と、28 日分の単位がある
    const inFile = parseUke(jitsurei).claims[0].units.filter((u) => u.items[0].kind === "IY").map((u) => u.days.filter((n) => n > 0));
    expect(inFile).toEqual([[14, 14], [28], [1, 1]]);
  });

  it("使用量：IY は整数部 5 桁・小数部 5 桁、TO は整数部 5 桁・小数部 3 桁。TO の単位コード・単価・商品名は読み捨てる", () => {
    const iy = rec(44, { 1: "IY", 2: "33", 3: 1, 4: "643310347", 5: "12345.12345", 6: 0, 7: 1, 14: 1 });
    const to = rec(48, { 1: "TO", 2: "40", 3: 1, 4: "739210000", 5: "12345.123", 6: 0, 7: 1, 8: "037", 9: "12345678.12", 18: 1 });
    const units = parseUke(ukeOf(insertAfter(rowsOf(jitsurei), /^SI,/, [iy, to]))).claims[0].units;
    expect(units.slice(1, 3).map((u) => u.items[0])).toEqual([expect.objectContaining({ kind: "IY", quantity: "12345.12345" }), expect.objectContaining({ kind: "TO", quantity: "12345.123" })]);
  });

  it("(c) 長い商品名の TO（300 バイト＝全角 150 文字）と、症状詳記 SJ（2,400 バイト＝全角 1,200 文字）を読める。それより長い項目は断る", () => {
    const to = (product: string) => rec(48, { 1: "TO", 2: "40", 3: 1, 4: "728720000", 5: 1, 6: 0, 7: 1, 8: "007", 11: product, 18: 1 });
    const rows = (product: string, note: string) => [...insertAfter(rowsOf(jitsurei), /^SI,/, [to(product)]).slice(0, -1), `SJ,07,${note}`, rowsOf(jitsurei).at(-1)!];
    const parsed = parseUke(ukeOf(rows("商".repeat(150), "詳".repeat(1200))));
    expect(parsed.claims[0].units[1].items).toEqual([expect.objectContaining({ kind: "TO", code: "728720000", quantity: "1" })]);
    expect(parsed.claims[3].notes).toEqual([{ kind: "07", text: "詳".repeat(1200) }]);
    expect(() => readUke(ukeOf(rows("商".repeat(150), "詳".repeat(1200))))).not.toThrow();
    expect(UKE_LIMITS.maxFieldLength).toBe(2400);
    expect(reasonOf(ukeOf(rows("商", "詳".repeat(UKE_LIMITS.maxFieldLength + 1))))[1]).toBe("項目が長すぎる");
  });

  it("合計：HO の合計点数に入るのは、医保に請求する負担区分の単位だけ（別表21）。薬剤料逓減などの減じる医薬品コードの単位は引く（手引き p63）。GO は各レセプトの HO の合計", () => {
    const third = parseUke(jitsurei).claims[2];
    const minus = third.units.find((u) => u.items[0].code === "630010002")!;
    expect([minus.points, minus.count]).toEqual([67, 1]);
    const plain = third.units.reduce((s, u) => s + u.points * u.count, 0);
    expect([third.total?.points, plain]).toEqual([744, 744 + 67 * 2]);
    // 公費だけが負担する単位（負担区分 5）は、HO の合計に入らない
    const rows = rowsOf(jitsurei);
    const kohiOnly = rec(44, { 1: "SI", 2: "12", 3: 5, 4: "112007410", 6: 76, 7: 1, 14: 1 });
    expect(() => readUke(ukeOf(insertAfter(rows, /^SI,/, [kohiOnly])))).not.toThrow();
    expect(reasonOf(ukeOf(insertAfter(rows, /^SI,/, [kohiOnly.replace("SI,12,5,", "SI,12,2,")])))).toEqual([3, "合計点数が行の合計と合わない"]);
    expect(reasonOf(ukeOf(insertAfter(rows, /^SI,/, [kohiOnly.replace("SI,12,5,", "SI,12,a,")])))[1]).toBe("負担区分の形が違う");
  });

  it("保険者番号は、8 桁に満たなければ先頭の空白を除いて読む（国保の 6 桁。仕様 p9）。都道府県コードは 47 都道府県を受け取る（別表2）", () => {
    expect(rowsOf(jitsurei).find((l) => l.startsWith("HO,"))).toMatch(/^HO, {2}139998,/);
    expect(parseUke(jitsurei).claims[0].patient.insurer).toEqual({ number: "139998", symbol: "99", no: "0000031" });
    const rows = rowsOf(jitsurei);
    for (const [code, name] of [["01", "北海道"], ["27", "大阪府"], ["47", "沖縄県"]]) expect(parseUke(ukeOf([rows[0].replace(/^IR,2,13,/, `IR,2,${code},`), ...rows.slice(1)])).prefecture).toBe(name);
    expect(reasonOf(ukeOf([rows[0].replace(/^IR,2,13,/, "IR,2,48,"), ...rows.slice(1)]))).toEqual([1, "未登録の都道府県コード"]);
  });
});

describe("実在の形の検証用の合成の UKE（fixtures/uke/jitsurei.UKE。EM 5-1）", () => {
  it("入力だけで決まり（作り直したものとファイルが一致）、患者は見本の誰とも違う。コードは設定のものだけ", () => {
    expect(generateJitsurei().equals(jitsurei)).toBe(true);
    const names = new Set(Object.values(loadSources().src.patients).map((p) => p.name));
    for (const r of JITSUREI.receipts) expect(names.has(r.patient.name)).toBe(false);
    const codes = new Set(JITSUREI.receipts.flatMap((r) => r.rows.map((x) => x.code)));
    for (const c of parseUke(jitsurei).claims) for (const u of c.units) for (const it of u.items) expect(codes.has(it.code)).toBe(true);
  });

  it("(e) parseUke で読め、mapClaim で「引ける単位」と「対象外の単位」に分かれる。HO の合計は行の合計と合う（EM 5-1 の表の値）", () => {
    const parsed = parseUke(jitsurei);
    expect(parsed.payer).toBe("国保連");
    const summary = parsed.claims.map((c) => {
      const m = mapClaim(c, rev);
      return {
        type: c.patient.receiptType,
        rows: c.units.reduce((s, u) => s + u.items.length, 0),
        units: c.units.length,
        ho: c.total?.points,
        mapped: m.units.filter((u) => u.ok).length,
        others: m.others.length,
        bad: m.units.filter((u) => u.ok === false && !u.unsupported).length,
        kubun: m.lines.map((l) => `${l.kubun}×${l.count}`),
      };
    });
    expect(summary).toEqual([
      { type: "1112", rows: 18, units: 12, ho: 845, mapped: 5, others: 7, bad: 0, kubun: ["A001×2", "D007_5×1", "D005_5×1", "D026_3×1", "D026_4×1"] },
      { type: "1118", rows: 14, units: 9, ho: 919, mapped: 1, others: 8, bad: 0, kubun: ["A001×1"] },
      { type: "1318", rows: 15, units: 9, ho: 744, mapped: 1, others: 8, bad: 0, kubun: ["A001×1"] },
      { type: "1318", rows: 5, units: 5, ho: 8350, mapped: 3, others: 2, bad: 0, kubun: ["C001_1I×2", "C103_2×1", "F400_3×2"] },
    ]);
    expect(parsed.total.points).toBe(845 + 919 + 744 + 8350);
    // 取り込み（readUke）でも同じ。対象外の単位は、コード・1 回分の点数・回数・1〜31 日の回数のまま残る
    const file = readUke(jitsurei, uploadClaimIdOf(1));
    expect(file.receipts.map((r) => [r.claimId, r.patientNo, r.lines.length, r.others?.length, r.declared?.ho, r.unreadable])).toEqual([
      ["U1-1", "200011", 5, 7, 845, undefined],
      ["U1-2", "200012", 1, 8, 919, undefined],
      ["U1-3", "200013", 1, 8, 744, undefined],
      ["U1-4", "200014", 3, 2, 8350, undefined],
    ]);
    expect(file.receipts[0].others![1]).toEqual({ unit: 2, codes: ["620491801", "610463223"], points: 1, count: 28, days: Array.from({ length: 31 }, (_, i) => (i === 14 || i === 28 ? 14 : 0)) });
    // 傷病名：修飾語コード・補足コメントを持つ行、未コード化の行、表にあるコードの行
    expect(file.receipts[0].patient.diseases).toEqual([
      { name: "高血圧症", start: "20250610", main: true },
      { name: "", code: "7262006", start: "20261015", modifiers: ["2056", "8002"] },
      { name: "便秘症", start: "20260115" },
    ]);
    expect(file.receipts[1].patient.diseases[2]).toEqual({ name: "", code: "8835114", start: "20260902", note: "健診にて" });
    // 単位に付くコメント（SI のコメント欄）と、単位の前の CO
    expect(file.receipts[3].comments).toEqual([{ code: "842100072", text: "50", raw: "５０", on: ["C103_2"] }]);
    expect(file.receipts[2].comments).toEqual([{ code: "820000047", text: "", raw: "", on: [] }]);
  });
});
