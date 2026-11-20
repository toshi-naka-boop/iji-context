// 算定回数の合計の上限（反証 round-28 S-5）：算定日の列は「日ごとの回数 × 数量データ」個できる。
// 数十 KB の UKE でも数億個になり得るので、作る前に数えて断る（取り込みでも、試算でも）
import { describe, expect, it } from "vitest";
import { REVISIONS } from "../../src/engine/revisions";
import { UKE_LIMITS } from "../../src/uke/limits";
import { encodeUke, mapClaim, parseUke, readUke } from "../../src/uke/uke";

/**
 * きざみの区分（外来迅速検体検査加算）を、毎日 9 回・数量 999 で並べた合成の UKE。
 * worst は、仕様の桁数いっぱい（回数 999 を 1 日の欄に。記録条件仕様 p16〜17）の行にする。kind を IY にすると、同じ回数の医薬品の行（点検の対象外の単位）
 */
function bomb(yearMonth: string, quantity: string, rows: number, worst = false, kind: "SI" | "IY" = "SI"): Buffer {
  const si = () => {
    const c = Array(44).fill("");
    c[0] = kind; c[1] = "60"; c[2] = "1"; c[3] = "160177770"; c[4] = quantity; c[5] = "0"; c[6] = worst ? "999" : "279";
    if (worst) c[13] = "999";
    else for (let d = 0; d < 31; d++) c[13 + d] = "9";
    return c.join(",");
  };
  const re = Array(38).fill("");
  re[0] = "RE"; re[1] = "1"; re[2] = "1318"; re[3] = yearMonth; re[4] = "架空"; re[5] = "1"; re[6] = "19450820"; re[13] = "1";
  const ho = Array(15).fill("");
  ho[0] = "HO"; ho[1] = "39139993"; ho[3] = "1"; ho[4] = "2"; ho[5] = "0";
  return encodeUke(["IR,2,13,1,9999999,,架空,202611,00,0300000000", re.join(","), ho.join(","), ...Array.from({ length: rows }, si), "GO,1,0,99"].join("\r\n") + "\r\n");
}

describe("算定回数の合計の上限", () => {
  it("取り込み：回数 × 数量が膨らむ UKE は、算定日の列を作る前に断る", () => {
    const started = Date.now();
    expect(() => readUke(bomb("202610", "999", 600), (_c, n) => `U1-${n}`)).toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("試算：版のない診療年月で取り込めた UKE を版で読んでも、上限を超えた単位は行にしない", () => {
    const claim = parseUke(bomb("202603", "99", 600)).claims[0];
    const started = Date.now();
    const mapped = mapClaim(claim, REVISIONS[0], true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mapped.lines.reduce((s, l) => s + l.dates.length, 0)).toBeLessThanOrEqual(UKE_LIMITS.maxClaimCount);
    expect(mapped.units.some((u) => u.ok === false && u.reason === "算定回数の合計が多すぎる")).toBe(true);
  });

  it("上限を仕様の桁数（回数 999）に広げた後の最悪の入力（回数 999 × 行数の上限）でも、日付の列を作らない：2 秒以内で、ヒープの増加は小さい", () => {
    /** 行数の上限いっぱい（IR・RE・HO・GO を除く） */
    const rows = UKE_LIMITS.maxLines - 4;
    const id = (_c: unknown, n: number) => `U1-${n}`;
    const heap = process.memoryUsage().heapUsed;
    const started = Date.now();
    // 診療行為（きざみの区分。数量は上限の 99）：取り込みは、算定日の列を作る前に断る
    expect(() => readUke(bomb("202610", String(UKE_LIMITS.maxQuantity), rows, true), id)).toThrow(/算定回数の合計が多すぎる/);
    // 版のない診療年月で取り込めたものを、版で読む（試算）：行にするのは上限まで
    const mapped = mapClaim(parseUke(bomb("202603", String(UKE_LIMITS.maxQuantity), rows, true)).claims[0], REVISIONS[0], true);
    expect(mapped.lines.reduce((s, l) => s + l.dates.length, 0)).toBeLessThanOrEqual(UKE_LIMITS.maxClaimCount);
    // 医薬品（点検の対象外の単位）：断らずに読むが、回数ぶんの日付は作らない（1〜31 日の回数のまま持つ）
    const file = readUke(bomb("202610", "1", rows, true, "IY"), id);
    expect([file.receipts[0].lines.length, file.receipts[0].others?.length, file.receipts[0].others?.[0].days.length]).toEqual([0, rows, 31]);
    expect(Date.now() - started).toBeLessThan(2000);
    // 回数ぶんの日付を作ると、999 × 4,996 行 ≒ 500 万個の文字列（数百 MB）になる
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(100 * 1024 * 1024);
  });
});
