// design.md §7 #22：年月の直書きの検査（scripts/check-dates.ts）の自己テスト
// このファイルの中の年月は、検査に渡す見本（テストは検査の対象の外）
import { describe, expect, it } from "vitest";
import { findDates, isTarget, run, targetFiles } from "../../scripts/check-dates";

const hitsOf = (source: string, file = "src/x.ts") => findDates(file, source).map((h) => [h.line, h.column]);

describe("年月の直書きの検査", () => {
  it("コメントの中の年月は一致にならない", () => {
    expect(hitsOf("// 2026-11-07 ユーザー判断\nconst a = 1; // 2025-03 のとき\n/* 2025-03-10\n 202503 */\n/** 例 K1-2026-10 */\nconst b = 2;\n")).toEqual([]);
  });
  it("文字列の年月は一致になり、ファイル・行・桁が出る", () => {
    const r = run([{ file: "src/x.ts", source: 'const a = 1;\nconst ym = "2025-03";\n' }]);
    expect(r.lines).toEqual(['src/x.ts:2:13: 2025-03";']);
    expect(r.exitCode).toBe(1);
  });
  it("YYYY-MM-DD の頭、請求 id の中の年月も当たる。単引用符も同じ", () => {
    expect(hitsOf('const d = "2025-03-10T09:00:00+09:00";')).toEqual([[1, 12]]);
    expect(hitsOf("const id = 'K1-2025-03';")).toEqual([[1, 16]]);
  });
  it("テンプレートの文字の部分は当たり、式の部分をはさんでも続きを見る", () => {
    expect(hitsOf("const s = `月は 2025-03 です`;")).toEqual([[1, 15]]);
    expect(hitsOf("const s = `${a}-${b}`;")).toEqual([]);
    expect(hitsOf("const s = `${f({ a: 1 })} は 2025-03`;")).toHaveLength(1);
    expect(hitsOf("const s = `${`入れ子 ${x}`} 2026-10`;")).toHaveLength(1);
  });
  it("6 桁の年月は、文字列の全体がその形のときだけ当たる", () => {
    expect(hitsOf('const ym = "202503";')).toEqual([[1, 13]]);
    expect(hitsOf('const code = "990202503";')).toEqual([]);
    expect(hitsOf("const n = 202503;")).toEqual([]);
  });
  it("JSX のテキストと正規表現リテラルの年月も当たる", () => {
    expect(hitsOf("export const A = () => <p>診療年月は 2025-03 です</p>;", "app/a.tsx")).toEqual([[1, 33]]);
    expect(hitsOf("export const A = () => <td>202503</td>;", "app/a.tsx")).toEqual([[1, 27]]);
    expect(hitsOf("const re = /^2025-03-\\d\\d$/;")).toEqual([[1, 14]]);
  });
  it("文字列の中の // はコメントにしない（その後ろの年月を見落とさない）", () => {
    expect(hitsOf('const u = "https://example.test/a"; const ym = "2025-03";')).toEqual([[1, 49]]);
  });
  it("一致がなければ終了コード 0、1 件でもあれば 0 でない", () => {
    expect(run([{ file: "src/x.ts", source: "const a = `${ym}-01`;\n" }])).toEqual({ lines: [], exitCode: 0 });
    expect(run([{ file: "src/x.ts", source: 'const a = "2031-01";\n' }]).exitCode).not.toBe(0);
  });
  it("見る対象は src・app・scripts の .ts・.tsx。版のファイル（src/engine/revisions/）は見ない", () => {
    expect(isTarget("src/engine/index.ts")).toBe(true);
    expect(isTarget("app/work/page.tsx")).toBe(true);
    expect(isTarget("scripts/gen-uke.ts")).toBe(true);
    expect(isTarget("src/engine/revisions/r2026.ts")).toBe(false);
    expect(isTarget("tests/engine/helpers.ts")).toBe(false);
    expect(isTarget("config/demo.json")).toBe(false);
    const files = targetFiles();
    expect(files).toContain("src/engine/index.ts");
    expect(files.some((f) => f.startsWith("src/engine/revisions/"))).toBe(false);
  });
});
