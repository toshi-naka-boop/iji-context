// config/shisetsu-kijun.json を EM §2-11 表 4 に縛る（design.md §15-2「名称の出どころ」。段 17b）。行は 1 対 1 で、列の文字列が同じ
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import kijun from "../../config/shisetsu-kijun.json";
import { GRADE_CHOICES, GRADE_CODES, HOSPITAL_CODES, KIJUN_OWNERS, NAYOSE, NOTE14_CODE } from "../../src/facility/codes";
import { LISTED_CODES } from "../../src/facility/declaration";

const em = readFileSync(path.join(__dirname, "../../design/iji-context/sources/evidence-master-iji-context.md"), "utf8");
const start = em.indexOf("#### 表 4　施設基準コードの名称");
const section = em.slice(start, em.indexOf("\n###", start + 10));
const cells = (l: string) => l.split("|").slice(1, -1).map((x) => x.trim());
/** 表の行（見出しと区切りの行を除く） */
const emRows = section
  .split("\n")
  .filter((l) => l.startsWith("|"))
  .map(cells)
  .slice(2);

describe("config/shisetsu-kijun.json と EM §2-11 表 4", () => {
  it("行が 1 対 1 で、コード・名称・ページ・厚生局の略称・使う区分が同じ", () => {
    expect(emRows.length).toBe(18);
    const json = kijun.rows.map((r) => [r.codes.length ? r.codes.join("・") : "—（コードなし）", r.name, r.page, r.abbrev, r.use]);
    expect(json).toEqual(emRows);
  });

  it("申告の一覧に出すコードは、その行のコードで、種別で決まるコード・在支病・名寄せ・注14 を含まない", () => {
    for (const r of kijun.rows) for (const c of r.listed) expect([c, r.codes.includes(c)]).toEqual([c, true]);
    for (const c of [...GRADE_CODES, ...HOSPITAL_CODES, "8032", "4101"]) expect([c, LISTED_CODES.includes(c)]).toEqual([c, false]);
  });

  it("読み方の例外の定数（種別のコード・在支病）は、表 4 の行にある", () => {
    const all = kijun.rows.flatMap((r) => r.codes);
    for (const c of [...GRADE_CODES, ...HOSPITAL_CODES]) expect([c, all.includes(c)]).toEqual([c, true]);
    expect(GRADE_CHOICES.map((g) => g.code)).toEqual(["3055", "3055", "4247", "4247", "3056", "3168", null]);
  });

  it("G10 の読み方の定数（名寄せ・注14・担当のルールの表）のコードは、表 4 の行にある（段 17e）", () => {
    const all = kijun.rows.flatMap((r) => r.codes);
    const used = [...Object.keys(NAYOSE), ...Object.values(NAYOSE).flat(), NOTE14_CODE, ...KIJUN_OWNERS.flatMap((o) => o.codes)];
    for (const c of used) expect([c, all.includes(c)]).toEqual([c, true]);
    // 名寄せ元は種別で決まるコードと同じ（［基］p172）
    expect([...NAYOSE["8032"]].sort()).toEqual([...GRADE_CODES].sort());
  });
});
