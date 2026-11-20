// scripts/check-codes.ts（版のコードと医科診療行為マスターの突き合わせ。design.md §11-1）。マスターは同梱しないので、版から作った合成の CSV で確かめる
import { describe, expect, it } from "vitest";
import { checkCodes, emNames, parseMaster } from "../../scripts/check-codes";
import { r2026 } from "../../src/engine/revisions/r2026";
import { r2027_06 } from "../../src/engine/revisions/r2027-06";

type Over = { name?: string; pointKind?: string; points?: number; bundled?: string; changedOn?: string; abolishedOn?: string };

/** マスターの 1 行（列は 1 起算で、3 コード・5 名称・11 点数識別・12 点数・16 包括対象検査・87 変更年月日・88 廃止年月日） */
function row(code: string, points: number, over: Over = {}): string {
  const c = Array.from({ length: 88 }, () => '"0"');
  const set = (n: number, v: string) => (c[n - 1] = `"${v}"`);
  set(3, code);
  set(5, over.name ?? `名称${code}`);
  set(11, over.pointKind ?? "3");
  set(12, (over.points ?? points).toFixed(2));
  set(16, over.bundled ?? "0");
  set(87, over.changedOn ?? `${r2026.effectiveFrom.replace("-", "")}01`);
  set(88, over.abolishedOn ?? "99999999");
  return c.join(",");
}

/** r2026 のコードをすべて持つ合成のマスター。over は、コードごとの差し替え */
function master(over: Record<string, Over | null> = {}) {
  const lines: string[] = [];
  const add = (code: string, points: number, base: Over = {}) => {
    if (over[code] !== null) lines.push(row(code, points, { ...base, ...over[code] }));
  };
  for (const [kubun, def] of Object.entries(r2026.codes)) for (const code of [def.primary, ...def.accept]) add(code, r2026.points[kubun].points!);
  for (const code of r2026.bundles[0].members) add(code, 11, { bundled: "1" });
  return parseMaster(`${lines.join("\r\n")}\r\n`);
}
const names = (m: ReturnType<typeof master>) => new Map([...m].map(([code, r]) => [code, r.name]));

describe("check-codes", () => {
  const C000 = r2026.codes.C000.primary;
  const member = r2026.bundles[0].members[0];

  it("版のコードがすべてマスターにあり、名称・点数・有効期間が合えば 0 件", () => {
    const m = master();
    expect(checkCodes(m, names(m))).toEqual([]);
  });

  it("マスターにないコード・名称の違い・点数の違い・点数識別の違い・適用期間に掛からない有効期間を、1 件ずつ出す", () => {
    const ok = master();
    const one = (over: Record<string, Over | null>) => checkCodes(master(over), names(ok), [r2026]);
    expect(one({ [C000]: null })).toEqual([`r2026 C000 ${C000}：マスターにない`]);
    expect(one({ [C000]: { name: "別の名称" } })).toHaveLength(1);
    expect(one({ [C000]: { points: 721 } })).toEqual([`r2026 C000 ${C000}：点数が違う（マスター 721／点数表 720）`]);
    expect(one({ [C000]: { pointKind: "1" } })).toHaveLength(1);
    expect(one({ [C000]: { abolishedOn: "20260531" } })).toHaveLength(1);
    expect(one({ [C000]: { changedOn: "20270601" } })).toHaveLength(1);
    // accept のコードも見る
    expect(one({ [r2026.codes.F400_2.accept[1]]: null })).toHaveLength(1);
  });

  it("包括の検査の項目は、マスターで包括対象検査になっていなければ出す。点数は比べない", () => {
    const ok = master();
    expect(checkCodes(master({ [member]: { bundled: "0" } }), names(ok), [r2026])).toEqual([`r2026 bundles[0] ${member}：マスターで包括対象検査になっていない`]);
    expect(checkCodes(master({ [member]: { points: 27 } }), names(ok), [r2026])).toEqual([]);
  });

  it("値の変更の版は、点数を比べない（その時点のマスターがまだないため）。コードがあることと有効期間は見る", () => {
    const m = master();
    expect(checkCodes(m, names(m), [r2027_06])).toEqual([]);
    expect(checkCodes(master({ [C000]: null }), names(m), [r2027_06])).toHaveLength(1);
  });

  it("EM §2-8 の表から、primary と包括の対象の名称が読める", () => {
    const em = [
      "### 2-8. 採用した診療行為コード",
      "| 区分キー | コード（primary） | ほかに受けるコード（accept） | マスターの名称（primary） | マスターの点数 | 診療識別 | 確度 | 備考 |",
      "| C000 | 114000110 | — | 往診料 | 720 | 14（手引き p36） | 高 |  |",
      "| 1 | 160000550 | 血中ケトン体（試験紙法） | 23 | 160020710 | ＡＬＤ | 45 | 160132150 | クレアチニン（尿） |",
      "### 2-9. 次の節",
      "| C999 | 999999999 | — | 節の外 | 1 | 14 | 高 |  |",
    ].join("\n");
    expect([...emNames(em)]).toEqual([
      ["114000110", "往診料"],
      ["160000550", "血中ケトン体（試験紙法）"],
      ["160020710", "ＡＬＤ"],
      ["160132150", "クレアチニン（尿）"],
    ]);
  });
});
