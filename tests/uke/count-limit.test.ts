// 算定回数の合計の上限（反証 round-28 S-5）：算定日の列は「日ごとの回数 × 数量データ」個できる。
// 数十 KB の UKE でも数億個になり得るので、作る前に数えて断る（取り込みでも、試算でも）
import { describe, expect, it } from "vitest";
import { REVISIONS } from "../../src/engine/revisions";
import { UKE_LIMITS } from "../../src/uke/limits";
import { encodeUke, mapClaim, parseUke, readUke } from "../../src/uke/uke";

/** きざみの区分（外来迅速検体検査加算）を、毎日 9 回・数量 999 で並べた合成の UKE */
function bomb(yearMonth: string, quantity: string, rows: number): Buffer {
  const si = () => {
    const c = Array(44).fill("");
    c[0] = "SI"; c[1] = "60"; c[2] = "1"; c[3] = "160177770"; c[4] = quantity; c[5] = "0"; c[6] = "279";
    for (let d = 0; d < 31; d++) c[13 + d] = "9";
    return c.join(",");
  };
  const re = Array(38).fill("");
  re[0] = "RE"; re[1] = "1"; re[2] = "1318"; re[3] = yearMonth; re[4] = "架空"; re[5] = "1"; re[6] = "19450820"; re[12] = "1";
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
});
