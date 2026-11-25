// 合成の UKE の直し（design.md §19-4 の 3・§19-10 完了条件 5）：kozoka.UKE・torikawasure.UKE の、手技と薬を 1 つにまとめていた単位を、
// 作成手引きの書き方（手技と薬を別の単位。R8-310）に直した。直したあとも、レセプトの合計点数は直す前と同じ
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUke } from "../../src/uke/uke";

const root = path.join(__dirname, "..", "..");
const claimsOf = (name: string) => parseUke(readFileSync(path.join(root, "fixtures", "uke", name))).claims;

describe("合成の UKE の直し（段 22d）", () => {
  it("レセプトの合計点数（HO）は直す前と同じ", () => {
    // 直す前（v44 の段 22d の前。90e2fe4 の UKE）の値
    expect(claimsOf("kozoka.UKE").map((c) => c.total?.points)).toEqual([14558, 1247]);
    expect(claimsOf("torikawasure.UKE").map((c) => c.total?.points)).toEqual([7117, 15606, 14951, 5846]);
  });

  it("点数の書いてある単位に、診療行為と医薬品が混ざったものはない（手技は SI の最後の行、薬は IY の最後の行に点数）", () => {
    for (const name of ["kozoka.UKE", "torikawasure.UKE"]) {
      for (const c of claimsOf(name)) {
        const mixed = c.units.filter((u) => typeof u.points === "number" && new Set(u.items.map((it) => it.kind)).size > 1);
        expect(mixed, name).toEqual([]);
      }
    }
  });
});
