// 増減点連絡書・返戻内訳書の CSV の読み取り（spec FR-202 の I-1）：ファイル名の規則、文字コード（UTF-8 とシフト JIS）、前の行の値を引き継ぐ省略規則、当て方の規則
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCsv, eraMonth, readFileName, readReviewCsv, ReviewError, splitCsv, type ReviewRow } from "../../src/review/format";
import { matchClaim, matchLine, type LineUnit, type ReceiptKey } from "../../src/review/match";

const dir = path.join(__dirname, "..", "..", "fixtures", "review");
const ZOGEN = "RIzogn2131999999950811.csv";

describe("ファイル名", () => {
  it("審査支払機関・都道府県・医療機関コード・処理年月を読む。紙レセプト分は MI。確認試験と医科以外と形の違う名前は断る", () => {
    expect(readFileName(ZOGEN)).toEqual({ kind: "zogen", paper: false, payer: "国保連", prefectureCode: "13", clinicCode: "9999999", processedMonth: "2026-11" });
    expect(readFileName("RIhenr1131999999950804.csv")).toMatchObject({ kind: "henrei", payer: "支払基金", processedMonth: "2026-04" });
    expect(readFileName("MIzogn1131999999950811.csv")).toMatchObject({ paper: true });
    expect(() => readFileName("RIzogn2131999999950811TEST.csv")).toThrow(/確認試験/);
    expect(() => readFileName("RIzogn2132999999950811.csv")).toThrow(/医科/);
    expect(() => readFileName("zogen.csv")).toThrow(ReviewError);
    expect(eraMonth("50810")).toBe("2026-10");
    expect(eraMonth("43104")).toBe("2019-04");
    expect(eraMonth("51300")).toBeNull();
  });
});

describe("文字コード", () => {
  it("UTF-8 でもシフト JIS でも同じ明細に読める。BOM と EOF は外す", () => {
    const sjis = readFileSync(path.join(dir, ZOGEN));
    const text = new TextDecoder("shift_jis").decode(sjis);
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8"), Buffer.from([0x1a])]);
    expect(decodeCsv(utf8)).toBe(text);
    expect(readReviewCsv(ZOGEN, utf8)).toEqual(readReviewCsv(ZOGEN, sjis));
    expect(readReviewCsv(ZOGEN, sjis).rows[0].name).toBe("架空　一郎");
    // どちらでも読めないバイト列は断る
    expect(() => decodeCsv(Buffer.from([0x82, 0xff, 0xff]))).toThrow(/文字コード/);
    // 同梱の支払基金の分は UTF-8
    expect(readReviewCsv("RIzogn1131999999950811.csv", readFileSync(path.join(dir, "RIzogn1131999999950811.csv"))).rows.map((r) => r.name)).toEqual(["架空　六郎"]);
  });

  it("引用符で囲んだ項目と、その中の \"\" を読む。LF だけの改行も読む", () => {
    expect(splitCsv('1,"a,b","c""d"\n2,,x\n')).toEqual([["1", "a,b", 'c"d'], ["2", "", "x"]]);
  });
});

describe("増減点連絡書の明細", () => {
  const csv = readReviewCsv(ZOGEN, readFileSync(path.join(dir, ZOGEN)));
  it("ヘッダの診療月を読み、タイトルと集計の行は読み飛ばす", () => {
    expect(csv.headerMonth).toBe("2026-10");
    expect(csv.rows).toHaveLength(9);
    expect(csv.rows.map((r) => r.recordType)).toEqual([3, 4, 3, 3, 5, 3, 3, 3, 3]);
  });
  it("2 行目以降でレセプト番号が空なら、項番 2〜19 を前の行から引き継ぐ。箇所が両方空なら前の行の箇所。合計の行は引き継がない", () => {
    const [a, b, , , total] = csv.rows;
    expect(b).toMatchObject({ receiptSeq: 1, receiptNo: "1", name: "架空　一郎", karte: "K1-2026-10", insurers: ["39139993"], kasho1: "60", points: -103, jiyu: ["B"] });
    expect(a).toMatchObject({ receiptSeq: 1, kasho1: "14", points: -900, jiyu: ["D"] });
    expect(total).toMatchObject({ recordType: 5, receiptSeq: 3, receiptNo: "3", name: "架空　三郎", insurers: ["39139993", "54139993"], kasho1: "", kasho2: "合計", points: -10, jiyu: ["H"] });
  });
  it("増減点数は符号つき、金額は ¥ つきで別に持つ。事由は最大 2 つを 1 字ずつ", () => {
    const head = `1,50810,1,医科,9999999\r\n`;
    const line = (pts: string, jiyu: string) => `3,,7,0001-00000009,,,,39139993,,,,,,本外,,,,架空　太郎,,14,,,${pts},${jiyu},,請求,,補正,,\r\n`;
    const rows = readReviewCsv(ZOGEN, Buffer.from(head + line("-¥7000", "FK") + line("＋２１６", ""), "utf8")).rows;
    expect(rows.map((r) => [r.points, r.amount, r.jiyu])).toEqual([[null, -7000, ["F", "K"]], [216, null, []]]);
  });
  it("先頭がヘッダでない・知らない種別・続きの行が先に来るファイルは、行番号つきで断る", () => {
    expect(() => readReviewCsv(ZOGEN, Buffer.from("3,,1\r\n"))).toThrow(/1 行目/);
    expect(() => readReviewCsv(ZOGEN, Buffer.from("1,50810\r\n9,x\r\n"))).toThrow(/2 行目：知らないレコード種別/);
    expect(() => readReviewCsv(ZOGEN, Buffer.from("1,50810\r\n4,,1\r\n"))).toThrow(/2 行目/);
  });
});

describe("返戻内訳書の明細", () => {
  it("受付番号が空の続きの行は、項番 2・3・5・7・18〜20 を引き継ぐ。電子請求分の診療年月（YYMM）は令和として読む", () => {
    const body = ["1,50810,1,医科,9999999", "3,0809,0003-00000001,39139993,本外,,架空　七郎,2,4972,,,,,,,1234,資格関係誤り,K7,,", "4,,,39139993,,,,,,,,,,,,5678,別の事由,,,"].join("\r\n");
    const rows = readReviewCsv("RIhenr2131999999950811.csv", Buffer.from(iconv.encode(body, "Shift_JIS"))).rows;
    expect(rows.map((r) => [r.receiptSeq, r.yearMonth, r.uketsuke, r.name, r.karte, r.jiyu, r.jiyuText])).toEqual([
      [1, "2026-09", "0003-00000001", "架空　七郎", "K7", ["1234"], "資格関係誤り"],
      [1, "2026-09", "0003-00000001", "架空　七郎", "K7", ["5678"], "別の事由"],
    ]);
  });
});

describe("請求への当て方", () => {
  const file = readFileName(ZOGEN);
  const key = (k: Partial<ReceiptKey>): ReceiptKey => ({ claimId: "X", payer: "国保連", billingMonth: "2026-11", clinicCode: "9999999", receiptNo: "1", patientNo: "", yearMonth: "2026-10", name: "架空　一郎", insurers: ["39139993"], checkable: true, noRevision: false, ...k });
  const row = (r: Partial<ReviewRow>): ReviewRow => ({ line: 3, recordType: 3, receiptSeq: 1, yearMonth: null, receiptNo: "1", uketsuke: "", insurers: ["39139993"], name: "架空 一郎", karte: "", kasho1: "14", kasho2: "", points: -1, amount: null, jiyu: ["D"], jiyuText: "", seikyu: "", satei: "", ...r });

  it("審査支払機関・医療機関コード・請求月・レセプト番号で当て、氏名（空白の違いは見ない）と保険者番号で検算する", () => {
    expect(matchClaim(file, null, row({}), [key({ claimId: "A" })])).toEqual({ claimId: "A" });
    expect(matchClaim(file, null, row({ name: "架空 一朗" }), [key({})])).toEqual({ claimId: null, reason: "氏名か保険者番号が合わない" });
    expect(matchClaim(file, null, row({ insurers: ["06139991"] }), [key({})])).toMatchObject({ claimId: null });
    // 審査支払機関・請求月・医療機関コードが違う請求には当てない
    for (const k of [{ payer: "支払基金" as const }, { billingMonth: "2026-10" }, { clinicCode: "1234567" }]) expect(matchClaim(file, null, row({}), [key(k)])).toMatchObject({ claimId: null, reason: "審査支払機関・請求月・レセプト番号の同じ請求がない" });
    // 月遅れで明細に診療年月があれば、それも合わなければ当てない
    expect(matchClaim(file, null, row({ yearMonth: "2026-09" }), [key({})])).toMatchObject({ claimId: null });
  });
  it("送信回をまたいで番号が重なれば当てない。カルテ番号等が両方にあって 1 件に決まれば、それを先に使う", () => {
    const two = [key({ claimId: "A", patientNo: "P1" }), key({ claimId: "B", patientNo: "P2", name: "架空　二郎" })];
    expect(matchClaim(file, null, row({}), two)).toMatchObject({ claimId: null, reason: expect.stringMatching(/2 件以上/) });
    expect(matchClaim(file, null, row({ karte: "P1" }), two)).toEqual({ claimId: "A" });
    expect(matchClaim(file, null, row({ karte: "P2" }), two)).toEqual({ claimId: null, reason: "氏名か保険者番号が合わない" });
  });
  it("返戻内訳書は保険者番号＋氏名＋診療年月（明細になければヘッダの診療月）で当てる", () => {
    const henrei = readFileName("RIhenr2131999999950811.csv");
    const keys = [key({ claimId: "A" }), key({ claimId: "B", yearMonth: "2026-09" })];
    expect(matchClaim(henrei, "2026-10", row({ receiptNo: "" }), keys)).toEqual({ claimId: "A" });
    expect(matchClaim(henrei, "2026-10", row({ receiptNo: "", yearMonth: "2026-09" }), keys)).toEqual({ claimId: "B" });
    expect(matchClaim(henrei, "2026-10", row({ receiptNo: "" }), [...keys, key({ claimId: "C", billingMonth: "2026-12" })])).toMatchObject({ claimId: null, reason: expect.stringMatching(/2 件以上/) });
  });
});

describe("行への当て方", () => {
  const units: LineUnit[] = [
    { unit: 0, shikibetsu: "14", codes: [{ code: "114001110", names: ["在宅患者訪問診療料（Ⅰ）１イ"] }] },
    { unit: 1, shikibetsu: "14", codes: [{ code: "114016070", names: ["在宅移行早期加算"] }] },
    { unit: 2, shikibetsu: "14", codes: [{ code: "114043870", names: ["包括的支援加算"] }] },
    { unit: 3, shikibetsu: "60", codes: [{ code: "160017410", names: ["血液化学検査 10項目以上"] }, { code: "160019010", names: ["血液化学検査 10項目以上"] }] },
    { unit: 4, shikibetsu: "60", codes: [{ code: "160061910", names: ["生化学的検査(Ⅰ)判断料"] }] },
    { unit: 5, shikibetsu: "14", codes: [{ code: "114723810", names: ["在宅医療情報連携加算"] }] },
  ];
  const row = (seikyu: string, r: Partial<ReviewRow> = {}): ReviewRow => ({ line: 3, recordType: 3, receiptSeq: 1, yearMonth: null, receiptNo: "1", uketsuke: "", insurers: [], name: "", karte: "", kasho1: "14", kasho2: "", points: -1, amount: null, jiyu: ["D"], jiyuText: "", seikyu, satei: "", ...r });
  it("NFKC にして空白を除き、名称が 1 つだけ含まれればそのコード。0 個・2 個以上は人が選ぶ", () => {
    expect(matchLine("zogen", row("在宅患者訪問診療料(I)1イ 890×1"), units)).toEqual({ scope: "code", code: "114001110" });
    expect(matchLine("zogen", row("在宅移行早期加算 100×1　包括的支援加算 150×1"), units)).toEqual({ scope: "choose", hits: ["114016070", "114043870"] });
    expect(matchLine("zogen", row("訪問診療 890×1"), units)).toEqual({ scope: "choose", hits: [] });
  });
  it("箇所1 と同じ診療識別の単位だけを見る（その値の単位がなければ絞らない）", () => {
    expect(matchLine("zogen", row("在宅移行早期加算 生化学的検査(Ⅰ)判断料", { kasho1: "60" }), units)).toEqual({ scope: "code", code: "160061910" });
    expect(matchLine("zogen", row("生化学的検査(Ⅰ)判断料", { kasho1: "99" }), units)).toEqual({ scope: "code", code: "160061910" });
  });
  it("1 つの単位の複数のコードが同じ名称で当たれば、その単位の先頭のコード。ほかの名称の一部でしかない名称は捨てる（最長一致）", () => {
    expect(matchLine("zogen", row("血液化学検査10項目以上 103×1", { kasho1: "60" }), units)).toEqual({ scope: "code", code: "160017410" });
    const nested: LineUnit[] = [{ unit: 0, shikibetsu: "14", codes: [{ code: "1", names: ["往診料"] }] }, { unit: 1, shikibetsu: "14", codes: [{ code: "2", names: ["夜間往診料加算"] }] }];
    expect(matchLine("zogen", row("夜間往診料加算 650×1"), nested)).toEqual({ scope: "code", code: "2" });
  });
  it("合計の行・金額の増減・事由 F・G・H・返戻内訳書は請求単位", () => {
    expect(matchLine("zogen", row("", { recordType: 5, kasho2: "合計" }), units)).toEqual({ scope: "claim" });
    expect(matchLine("zogen", row("在宅移行早期加算", { amount: -700, points: null }), units)).toEqual({ scope: "claim" });
    for (const j of ["F", "G", "H"]) expect(matchLine("zogen", row("在宅移行早期加算", { jiyu: ["K", j] }), units)).toEqual({ scope: "claim" });
    expect(matchLine("henrei", row("在宅移行早期加算"), units)).toEqual({ scope: "claim" });
  });
});
