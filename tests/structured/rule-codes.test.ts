// 規則で出す算定のコード（design.md §16-4。W-15）：RULE_CODES が EM §2-8 の別表「規則の候補で使うコード」の行（区分キーと EM の行）と合う。設計パラメータ（L-201）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_CODES, SECOND_PATIENT_COMMENT, structuredConfig } from "../../src/structured/rule-codes";

const em = readFileSync(path.join(__dirname, "..", "..", "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8").split("\n");
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const start = em.findIndex((l) => l.startsWith("**規則の候補で使うコード"));
const table = new Map(
  em
    .slice(start, em.findIndex((l, i) => i > start && l.startsWith("### ")))
    .filter((l) => /^\| \d{9} \|/.test(l))
    .map(cells)
    .map((c) => [c[0], c[1]] as const),
);

describe("RULE_CODES と EM", () => {
  it("どのコードも EM の別表の行にあり、区分キー（EM の行）が名前と合う", () => {
    const want: Record<keyof typeof RULE_CODES, string> = {
      chozaiOral: "F000_1I（R8-228）",
      chozaiExternal: "F000_1RO（R8-229）",
      mayakuChozai: "F000_N（R8-230）",
      shohoryo3: "F100_3（R8-231）",
      shohoryo2: "F100_2（R8-232）",
      mayakuShohoryo: "F100_N2（R8-233）",
      kakaVisit: "C001_N5_KAKA（R8-202）",
      kakaOushin: "C000_N2_KAKA（R8-203）",
      kakaOushinSpecial: "C000_N2_KAKA（R8-203）",
    };
    for (const [k, code] of Object.entries(RULE_CODES)) expect([k, table.get(code)]).toEqual([k, want[k as keyof typeof RULE_CODES]]);
  });
  it("同じ患家の 2 人目以降の摘要欄の記載のコードは EM に書いてある（R8-207。§2-10）", () => {
    expect(em.some((l) => l.includes(SECOND_PATIENT_COMMENT))).toBe(true);
  });
  it("注2 の確かめにさかのぼる月数は設定の 1 か所（config/structured.json）で、12 か月（L-201 の既定）", () => {
    expect(structuredConfig().rxLookbackMonths).toBe(12);
  });
});
