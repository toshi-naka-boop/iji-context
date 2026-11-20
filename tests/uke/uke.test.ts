// F4：合成 UKE 2 本（spec FR-05・FR-06、impl-plan 11/5 の完了条件）
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BILLING_MONTH, CASES, generate, loadSources, UKE_FILES } from "../../scripts/gen-uke";
import { evaluate } from "../../src/engine";
import { fictionalCode } from "../../src/engine/codes-fictional";
import { buildUkeFiles, payerOfInsurer, toClaimContext } from "../../src/uke/cases";
import { UKE_LIMITS } from "../../src/uke/limits";
import { formatUke, parseUke, UkeError, writeUke } from "../../src/uke/uke";
import { loadCase } from "../engine/helpers";
import { claimId, dateIn, day } from "../helpers/period";

const root = path.join(__dirname, "..", "..");
const read = (f: string) => readFileSync(path.join(root, f));
const files = { 国保連: parseUke(read(UKE_FILES.国保連)), 支払基金: parseUke(read(UKE_FILES.支払基金)) };

describe("2 本を読む", () => {
  it("IR=2（国保連）で K1〜K5 と K7、IR=1（支払基金）で K6。合わせて 7 件", () => {
    expect(read(UKE_FILES.国保連).toString("latin1").startsWith("IR,2,13,1,")).toBe(true);
    expect(read(UKE_FILES.支払基金).toString("latin1").startsWith("IR,1,13,1,")).toBe(true);
    expect(files.国保連.receipts.map((r) => r.claimId)).toEqual([claimId("K1"), claimId("K2"), claimId("K3"), claimId("K4"), claimId("K5"), claimId("K7")]);
    expect(files.支払基金.receipts.map((r) => r.claimId)).toEqual([claimId("K6")]);
    expect(files.国保連.billingMonth).toBe(BILLING_MONTH);
  });

  it("読んだレセプトとカルテ側の事実を合わせると、症例 JSON と同じ ClaimContext・同じ判定になる", () => {
    for (const k of CASES) {
      const want = loadCase(k);
      const file = want.payer === "国保連" ? files.国保連 : files.支払基金;
      const got = toClaimContext(file, want.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
      expect(got.lines).toEqual(want.lines);
      expect(got.comments).toEqual(want.comments ?? []);
      expect([got.yearMonth, got.payer, got.prefecture]).toEqual([want.yearMonth, want.payer, want.prefecture]);
      expect(evaluate(got)).toEqual(evaluate(want));
    }
  });

  it("同じ区分を 2 行に分けた UKE でも、月 1 回の判断料の 2 回目を見逃さない（X-75）", () => {
    const { cases, src } = loadSources();
    const k2 = cases.find((c) => c.claimId === claimId("K2"))!;
    const want = loadCase("K2");
    const twice = { ...k2, lines: [...k2.lines, { kubun: "D026_3", count: 1, dates: [day(28)] }] };
    const file = parseUke(writeUke(buildUkeFiles([twice], src, BILLING_MONTH).国保連));
    const got = toClaimContext(file, k2.claimId, { facility: want.facility, facts: want.facts, events: want.events, recordsKnown: want.recordsKnown, history: want.history });
    expect(got.lines.filter((l) => l.kubun === "D026_3")).toHaveLength(2);
    expect(evaluate(got).findings.map((f) => f.messageKey)).toEqual(["R11.judgement_once_a_month"]);
  });

  it("K3 は公費（54）が 1 件目の KO に載り、負担区分は 2（医保＋公費①）", () => {
    const k3 = files.国保連.receipts.find((r) => r.claimId === claimId("K3"))!;
    expect(k3.patient.kohi.map((x) => x.payerNo.slice(0, 2))).toEqual(["54"]);
    expect(k3.patient.receiptType).toBe("1328");
    const text = new TextDecoder("shift_jis").decode(read(UKE_FILES.国保連));
    const k3si = text.split("\r\n").slice(text.split("\r\n").findIndex((l) => l.includes(claimId("K3")))).find((l) => l.startsWith("SI,"))!;
    expect(k3si.split(",")[2]).toBe("2");
  });

  it("K5 の主傷病の転帰は死亡（3）", () => {
    const k5 = files.国保連.receipts.find((r) => r.claimId === claimId("K5"))!;
    expect(k5.patient.diseases[0]).toMatchObject({ name: "末期悪性腫瘍", main: true, outcome: 3 });
  });
});

describe("形式（FR-06）", () => {
  it("Shift_JIS・CRLF・末尾 EOF(0x1A)。レコード順は IR→(RE→HO/KO→SY→SI/CO)×n→GO", () => {
    for (const f of Object.values(UKE_FILES)) {
      const b = read(f);
      expect(b[b.length - 1]).toBe(0x1a);
      const text = new TextDecoder("shift_jis", { fatal: true }).decode(b.subarray(0, -1));
      expect(text.endsWith("\r\n")).toBe(true);
      expect(text.replaceAll("\r\n", "").includes("\n")).toBe(false);
      const kinds = text.slice(0, -2).split("\r\n").map((l) => l.slice(0, 2));
      expect(kinds.join(" ")).toMatch(/^IR( RE HO( KO)*( SY)+( SI( CO)*)+)+ GO$/);
    }
  });

  it("列数は IR 10・RE 38・HO 15・KO 12・SY 8・SI 44・GO 4", () => {
    const want: Record<string, number> = { IR: 10, RE: 38, HO: 15, KO: 12, SY: 8, SI: 44, CO: 5, GO: 4 };
    for (const f of Object.values(UKE_FILES)) {
      const text = new TextDecoder("shift_jis").decode(read(f).subarray(0, -1));
      for (const l of text.slice(0, -2).split("\r\n")) expect(l.split(",").length).toBe(want[l.slice(0, 2)]);
    }
  });

  it("書き出しは入力だけで決まる（作り直したものとファイルが一致）", () => {
    const out = generate();
    expect(out.国保連.equals(read(UKE_FILES.国保連))).toBe(true);
    expect(out.支払基金.equals(read(UKE_FILES.支払基金))).toBe(true);
  });

  it("CO は直前の SI の区分に付く（往復で保たれる）", () => {
    const { cases, src } = loadSources();
    const k6 = { ...cases.find((c) => c.claimId === claimId("K6"))!, comments: [{ kubun: "D008_19", code: "820100001" }] };
    const back = parseUke(writeUke(buildUkeFiles([k6], src, BILLING_MONTH).支払基金));
    expect(back.receipts[0].comments).toEqual([{ kubun: "D008_19", code: "820100001" }]);
  });

  it("レセプトの診療年月の版にない区分のコード（前の年度だけの O100_3I）を含むファイルは拒否する。表にないコードも拒否する", () => {
    const good = read(UKE_FILES.支払基金);
    const text = new TextDecoder("shift_jis").decode(good.subarray(0, -1));
    const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
    const bnp = fictionalCode("D008_19");
    expect(text).toContain(bnp);
    expect(() => parseUke(enc(text.replace(bnp, fictionalCode("O100_3I"))))).toThrow("5 行目：診療年月の版にない区分のコード");
    expect(() => parseUke(enc(text.replace(bnp, "990009999")))).toThrow("5 行目：架空コードの表にないコード");
  });

  it("コードは架空コードの表どおり（行ごとに、区分のコードが SI に載る）", () => {
    const text = new TextDecoder("shift_jis").decode(read(UKE_FILES.国保連).subarray(0, -1));
    const codes = new Set(text.split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(",")[3]));
    const want = new Set(loadSources().cases.filter((c) => c.payer === "国保連").flatMap((c) => c.lines.map((l) => fictionalCode(l.kubun))));
    expect([...codes].sort()).toEqual([...want].sort());
  });

  it("壊れた UKE は例外：EOF なし・GO の合計違い・算定日と回数の不一致・RE より前の SI", () => {
    const good = read(UKE_FILES.支払基金);
    expect(() => parseUke(good.subarray(0, -1))).toThrow(/EOF/);
    const text = new TextDecoder("shift_jis").decode(good.subarray(0, -1));
    const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
    expect(() => parseUke(enc(text.replace(/GO,1,(\d+),99/, "GO,1,1,99")))).toThrow(/総合計点数/);
    expect(() => parseUke(enc(text.replace(/^(SI,60,1,\d+,,130,)1,/m, "$12,")))).toThrow(/回数/);
    expect(() => parseUke(enc(text.replace(/^RE,.*\r\nHO,.*\r\n/m, "")))).toThrow(/RE より前/);
  });

  describe("受け取れない入力は、行番号つきの UkeError になる（FR-106・FR-107）", () => {
    const good = read(UKE_FILES.支払基金);
    const text = new TextDecoder("shift_jis").decode(good.subarray(0, -1));
    const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
    /** 壊した UKE を読ませて、行番号と理由を取り出す（UkeError でなければテストを落とす） */
    const reject = (buf: Buffer): [number | null, string] => {
      try {
        parseUke(buf);
      } catch (e) {
        if (e instanceof UkeError) return [e.line, e.reason];
        throw e;
      }
      throw new Error("読めてしまった");
    };
    /** n 行目（1 起算）の col 列目（0 起算）を差し替える */
    const withCell = (n: number, col: number, value: string) => {
      const rows = text.slice(0, -2).split("\r\n").map((l) => l.split(","));
      rows[n - 1][col] = value;
      return enc(`${rows.map((r) => r.join(",")).join("\r\n")}\r\n`);
    };
    /** K6 の見本の行：1 IR・2 RE・3 HO・4 SY・5 SI・6 SI・7 GO。SI の 14 列目（0 起算で 13）からが 1 日〜31 日の回数 */
    const SI = 5;

    it("列数の不足・未対応のレコード・項目の長すぎ・制御文字", () => {
      expect(reject(enc(text.replace(/^(SI,.*),\r\n/m, "$1\r\n")))).toEqual([SI, "列数が合わない"]);
      expect(reject(enc(text.replace(/^SY,/m, "XX,")))).toEqual([4, "未対応のレコード"]);
      expect(reject(enc(text.replace(/^constructor,/m, "").replace(/^SY,/m, "constructor,")))).toEqual([4, "未対応のレコード"]);
      expect(reject(withCell(2, 4, "あ".repeat(UKE_LIMITS.maxFieldLength + 1)))).toEqual([2, "項目が長すぎる"]);
      expect(reject(withCell(2, 4, "架空\u0000六郎"))).toEqual([2, "制御文字がある"]);
    });

    it("範囲の外の数値・数字でない項目（符号・小数・指数を含む）", () => {
      expect(reject(withCell(2, 5, "3"))).toEqual([2, "性別が範囲の外"]);
      expect(reject(withCell(2, 3, "202613"))).toEqual([2, "診療年月の形が違う"]);
      expect(reject(withCell(2, 6, "1956-04-01"))).toEqual([2, "生年月日の形が違う"]);
      expect(reject(withCell(SI, 6, "0"))).toEqual([SI, "回数が範囲の外"]);
      for (const v of ["-1", "1.5", "1e9", "Infinity", "", " 1"]) expect(reject(withCell(SI, 6, v))).toEqual([SI, "回数が数字でない"]);
      expect(reject(withCell(SI, 5, "99999999"))).toEqual([SI, "点数が範囲の外"]);
      expect(reject(withCell(4, 1, "8830001"))).toEqual([4, "傷病名コードは未コード化（名称だけ）のものに限る"]);
    });

    it("SI の点数が版の点数表と合わない・HO の合計点数が行の合計と合わないものは断る。理由に値は入らない（X-76）", () => {
      // BNP の点数 130 → 9999、空欄。HO の合計 274 → 1
      expect(reject(withCell(SI, 5, "9999"))).toEqual([SI, "点数が診療年月の版の点数表と合わない"]);
      expect(reject(withCell(SI, 5, ""))).toEqual([SI, "点数が診療年月の版の点数表と合わない"]);
      expect(reject(withCell(3, 5, "1"))).toEqual([3, "合計点数が行の合計と合わない"]);
      for (const buf of [withCell(SI, 5, "9999"), withCell(3, 5, "12345")]) expect(() => parseUke(buf)).toThrow(/^\d+ 行目：(?!.*(9999|12345|130|274))/);
      // 同梱の見本は 2 本とも通る
      for (const f of Object.values(UKE_FILES)) expect(() => parseUke(read(f))).not.toThrow();
    });

    it("1 日の回数は上限まで。大きな数を入れても、日付の並びを作らずに断る", () => {
      const day1 = 13;
      const started = Date.now();
      for (const v of ["10", "999999999", "1e9", "-1", "1.5"]) expect(reject(withCell(SI, day1, v))).toEqual([SI, "1 日の回数が上限を超えている"]);
      expect(Date.now() - started).toBeLessThan(1000);
      // 上限の中でも、回数と合わなければ断る
      expect(reject(withCell(SI, day1, String(UKE_LIMITS.maxDailyCount)))).toEqual([SI, "算定日の合計と回数が合わない"]);
    });

    it("請求 id の文字種・重複。診療年月に当たる版がない", () => {
      for (const v of ["../K6", "K6/x", "K6 2026", "", "K6.json", "Ｋ６", "x".repeat(21)]) expect(reject(withCell(2, 12, v))).toEqual([2, "請求 id に使えない文字がある"]);
      const twice = text.replace(/^(RE,[\s\S]*)(GO,1,)(\d+)(,99\r\n)$/m, (_, body: string, go: string, total: string, tail: string) => `${body}${body}GO,2,${Number(total) * 2}${tail}`);
      expect(reject(enc(twice))).toEqual([7, "同じ請求 id のレセプトが 2 つある"]);
      expect(reject(withCell(2, 3, "202503"))).toEqual([2, "診療年月に当たる版がない"]);
    });

    it("大きすぎるファイル・多すぎる行・Shift_JIS でないバイト列・空のファイル", () => {
      expect(reject(Buffer.alloc(UKE_LIMITS.maxBytes + 1, 0x41))).toEqual([null, "ファイルが大きすぎる"]);
      const many = `${"SY,0000999,20260801,1,,x,,\r\n".repeat(UKE_LIMITS.maxLines + 1)}`;
      expect(reject(enc(many))).toEqual([null, "レコードの数が上限を超えている"]);
      expect(reject(Buffer.from([0x81, 0x0d, 0x0a, 0x1a]))).toEqual([null, "Shift_JIS として読めない"]);
      expect(reject(Buffer.alloc(0))).toEqual([null, "末尾に EOF(0x1A) がない"]);
      expect(reject(enc("IR,1,13,1,9999999,,x,202611,00,0300000000\r\n"))).toEqual([1, "末尾が GO レコードでない"]);
    });

    it("理由に、入力の値（氏名・番号・コード）は入らない", () => {
      const cases = [withCell(SI, 3, "990009999"), withCell(2, 12, "../../secret"), withCell(2, 5, "架空の値"), withCell(1, 2, "99"), enc(text.replace(/^SY,/m, "ZZ99,"))];
      for (const buf of cases) {
        const message = (() => {
          try {
            parseUke(buf);
            return "";
          } catch (e) {
            return (e as Error).message;
          }
        })();
        expect(message).toMatch(/^\d+ 行目：/);
        expect(message).not.toMatch(/990009999|secret|架空の値|ZZ99|六郎|01139997/);
      }
    });
  });

  it("書けない入力は例外：その版にない区分、診療年月の外の日付", () => {
    const { cases, src } = loadSources();
    const k6 = cases.find((c) => c.claimId === claimId("K6"))!;
    // 前の年度だけの区分（表にコードは残るが、診療年月の版の点数表にない）
    const bad1 = { ...k6, lines: [...k6.lines, { kubun: "O100_3I", count: 1, dates: [day(14)] }] };
    expect(() => formatUke(buildUkeFiles([bad1], src, BILLING_MONTH).支払基金)).toThrow(/未知の区分/);
    const bad2 = { ...k6, lines: [{ kubun: "D008_19", count: 1, dates: [dateIn(1, 1)] }] };
    expect(() => formatUke(buildUkeFiles([bad2], src, BILLING_MONTH).支払基金)).toThrow(/診療年月の外/);
  });
});

describe("審査支払機関は保険証（保険者番号）で決まる", () => {
  it("6 桁（国保）と 39 で始まる 8 桁（後期）は国保連、それ以外の 8 桁（社保）は支払基金。形式が違えば例外", () => {
    expect(payerOfInsurer("139999")).toBe("国保連");
    expect(payerOfInsurer("39139999")).toBe("国保連");
    expect(payerOfInsurer("01139999")).toBe("支払基金");
    expect(payerOfInsurer("06139999")).toBe("支払基金");
    expect(() => payerOfInsurer("1234")).toThrow(/形式/);
  });

  it("K1〜K5 と K7 は後期高齢者で国保連、K6 は協会けんぽで支払基金", () => {
    const { cases, src } = loadSources();
    expect(cases.map((c) => [c.claimId, payerOfInsurer(src.patients[c.claimId].insurer.number)])).toEqual([
      [claimId("K1"), "国保連"], [claimId("K2"), "国保連"], [claimId("K3"), "国保連"], [claimId("K4"), "国保連"], [claimId("K5"), "国保連"], [claimId("K6"), "支払基金"], [claimId("K7"), "国保連"],
    ]);
  });

  it("請求の審査支払機関が保険証と食い違うと UKE を作らない", () => {
    const { cases, src } = loadSources();
    const k6 = { ...cases.find((c) => c.claimId === claimId("K6"))!, payer: "国保連" as const };
    expect(() => buildUkeFiles([k6], src, BILLING_MONTH)).toThrow(/保険証/);
  });
});
