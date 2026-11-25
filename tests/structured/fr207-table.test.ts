// 段 19f（design.md §16-4-8・16-10）：FR-207 の表の網羅。FR207_CELLS の全部の升の id（T1〜T15 × 6 列と、升の中の番号ごとの id。C-413）に、1 件以上のテストがあることを確かめる。
// テストの名前は、テストを走らせずに vitest の一覧（vitest list --json。ファイルを読み込んで集める）から集める。升の id はテストの名前の頭（「id・id：中身」）に入れる決まり
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FR207_CELLS, FR207_ROWS } from "../../src/structured/fr207-table";

const repo = path.join(__dirname, "..", "..");
/** 升のテストを置くファイル（作った表のテストと、実データのテスト） */
const FILES = ["tests/generic/g11-structured.test.ts", "tests/structured/g11-rules-real.test.ts"];

/** テストの名前（describe の名前を「 > 」でつないだもの）の一覧 */
function testNames(): string[] {
  const out = execFileSync(path.join(repo, "node_modules", ".bin", "vitest"), ["list", "--json", "--no-staticParse", ...FILES], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } });
  return (JSON.parse(out.slice(out.indexOf("["))) as { name: string }[]).map((t) => t.name);
}

/** テストの名前の最後の段の頭にある升の id（「T6-背反で出ない-2・T6-…：中身」） */
const idsOf = (name: string): string[] => {
  const last = name.split(" > ").at(-1) ?? "";
  const head = last.includes("：") ? last.slice(0, last.indexOf("：")) : "";
  return head.split("・").filter((x) => /^T\d+-/.test(x));
};

describe("FR-207 の表の網羅（16-4-8。L-197・C-413）", () => {
  const names = testNames();
  const covered = new Set(names.flatMap(idsOf));
  it("表の行は T1〜T15、列は 6 つで、升の中の番号ごとに別の id（T6 の背反 4・見ない 10、T7 の見ない 2）", () => {
    expect(FR207_ROWS).toEqual(Array.from({ length: 15 }, (_, i) => `T${i + 1}`));
    expect(FR207_CELLS.length).toBe(15 * 6 - 3 + 4 + 10 + 2);
    expect(new Set(FR207_CELLS).size).toBe(FR207_CELLS.length);
  });
  it("FR207_CELLS の全部の升の id に、1 件以上のテストがある", () => {
    expect(FR207_CELLS.filter((id) => !covered.has(id))).toEqual([]);
  });
  it("テストの名前にある升の id は、どれも表にある（書き間違いの id で升を満たしたことにしない）", () => {
    expect([...covered].filter((id) => !FR207_CELLS.includes(id))).toEqual([]);
  });
  it("T1〜T6 の「在医総管の月で出ない」を実データで確かめるテストがある（マスターがあるときだけ動き、ないときは一覧に出ないので、ファイルの中で名前を確かめる。RESEMEN_MASTER_DIR）", () => {
    const src = readFileSync(path.join(repo, FILES[1]), "utf8");
    expect(src).toMatch(/withData\("T1〜T4・T5 の在医総管の月で出ない：[^"]*T6（注2）は在医総管の月に出る"/);
    // マスターがあるときは、一覧にも出る
    if (process.env.RESEMEN_MASTER_DIR && existsSync(path.join(process.env.RESEMEN_MASTER_DIR, "masters.db")))
      expect(names.some((n) => n.includes("T1〜T4・T5 の在医総管の月で出ない"))).toBe(true);
  });
});
