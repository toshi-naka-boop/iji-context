// 「施設の申告による」の漏れを縛る（design.md §15-4。FR-191）：同梱の症例と練習問題の入力で、申告の値を 1 つずつ変えて出る指摘の種類が変わるなら、
// その種類は src/messages.ts の BY_DECLARATION に載っていなければならない（§11-6 の recordFindings と同じ流儀）。
// あわせて、申告から来た値として渡しても（facilityBasis が declaration）、同梱の症例と練習問題の指摘は変わらない（段 17d の完了条件）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import type { ClaimContext, Facility, FacilityGrade } from "../../src/engine/types";
import { DECLARED_KEYS } from "../../src/facility/declaration";
import { BY_DECLARATION, BY_DECLARATION_NOTE, findingText } from "../../src/messages";
import { DOCTOR_DRILLS } from "../../src/practice/doctor-drills";
import { DRILLS } from "../../src/practice/drills";
import { day } from "../helpers/period";
import { line, loadCase, withLines } from "./helpers";

const NAMES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const nameOf = (claimId: string) => claimId.split("-")[0];
const K1 = loadCase("K1");
const visitDay = K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0];
const INPUTS: { name: string; ctx: ClaimContext }[] = [
  ...NAMES.map((n) => ({ name: n, ctx: loadCase(n) })),
  ...DRILLS.map((d) => ({ name: `練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  ...DOCTOR_DRILLS.map((d) => ({ name: `医師確認の練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  // 在支診かで結論が変わる道（往診の翌日の訪問診療料）を通す入力
  { name: "K1＋訪問診療の前日の往診料", ctx: withLines(K1, line("C000", 1, [`${visitDay.slice(0, 8)}${String(Number(visitDay.slice(8)) - 1).padStart(2, "0")}`])) },
];
/** 漏れを探す入力：上に、単一建物の人数で結論が変わる道（段 17f）を足す。管理料を 2 人以上の区分・10 人以上の区分にした K1（患者ごとの人数の区分は 2〜9 人と確かめた）。
 * 申告から来た値かで結論が変わる（申告だけから 1 人と決まると R19 は直さず食い違いの情報不足。C-251）ので、下の「変わらない」の入力には入れない */
const LEAK_INPUTS = [...INPUTS, ...(["C002_2I2", "C002_2I3"] as const).map((k) => ({ name: `K1 の管理料を ${k}`, ctx: bandCase(K1, k) }))];
// 注14（段 17h）：10 人以上の区分の通常の行と減の行（患者の人数の区分は 10〜19 人と確かめた）。note14 を 1 つずつ変える入力
LEAK_INPUTS.push(...(["C002_2I3", "C002_2I3_N14"] as const).map((k) => ({ name: `K1 の管理料を ${k}（10〜19 人）`, ctx: { ...bandCase(K1, k), facts: { ...bandCase(K1, k).facts, buildingBand: { known: true, value: "10-19" as const } } } })));

/** K1 の管理料の行を kubun に替え、患者ごとの人数の区分を 2〜9 人と確かめた請求 */
function bandCase(c: ClaimContext, kubun: string): ClaimContext {
  return { ...c, lines: c.lines.map((l) => (l.kubun.startsWith("C002_2") ? { ...l, kubun } : l)), facts: { ...c.facts, buildingBand: { known: true, value: "2-9" } } };
}
const GRADE_OF = (f: Facility, g: FacilityGrade): Facility => ({ ...f, grade: { known: true, value: g }, zaishishin: g !== "3", kyokagata: g === "1B" || g === "1N", hasBeds: g === "1B" });
/** 申告の値ごとの変え方（分かっている値だけ。分からないは情報不足で、種類の文を持たない） */
const VARIANTS: Record<(typeof DECLARED_KEYS)[number], ((f: Facility) => Facility)[]> = {
  grade: (["1B", "1N", "2", "3"] as FacilityGrade[]).map((g) => (f: Facility) => GRADE_OF(f, g)),
  note16Met: [true, false].map((v) => (f: Facility) => ({ ...f, note16Met: { known: true, value: v } })),
  dxTier: (["1", "2", "なし"] as const).map((v) => (f: Facility) => ({ ...f, dxTier: { known: true, value: v } })),
  baseUp: (["通常", "注5", "なし"] as const).map((v) => (f: Facility) => ({ ...f, baseUp: { known: true, value: v } })),
  building: (["none", "some"] as const).map((v) => (f: Facility) => ({ ...f, building: { known: true, value: v } })),
  note14: (["通常", "減算"] as const).map((v) => (f: Facility) => ({ ...f, note14: { known: true, value: v } })),
};
const declared: ClaimContext["facilityBasis"] = Object.fromEntries(DECLARED_KEYS.map((k) => [k, "declaration"]));
const kindsOf = (c: ClaimContext) => new Set(evaluate(c).findings.filter((f) => !f.messageKey.endsWith(".missing_fact")).map((f) => f.messageKey));

describe("byDeclaration の漏れ（design.md §15-4）", () => {
  const changed = new Set<string>();
  for (const { ctx } of LEAK_INPUTS)
    for (const vary of Object.values(VARIANTS))
      for (const basis of [undefined, declared]) {
        const sets = vary.map((v) => kindsOf({ ...ctx, facility: v(ctx.facility), facilityBasis: basis }));
        const all = new Set(sets.flatMap((s) => [...s]));
        for (const k of all) if (sets.some((s) => !s.has(k))) changed.add(k);
      }

  it("申告の値を 1 つずつ変えて出る種類が変わるものは、どれも BY_DECLARATION に載っている", () => {
    expect([...changed].filter((k) => !BY_DECLARATION.has(k)).sort()).toEqual([]);
  });
  it("空振りしていない：種別・DX・ベースアップ・在支診の道で、変わる種類が実際に見つかる", () => {
    expect([...changed]).toEqual(expect.arrayContaining(["R18.use_grade", "R18.use_baseup_note5", "R12.dx_tier", "R12.dx_not_notified", "R10.visit_day_after_oushin", "R19.use_band", "R18.use_note14_reduced"]));
  });
  it("BY_DECLARATION の種類の文には「（施設の申告による）」が付く", () => {
    const f = evaluate({ ...K1, facility: GRADE_OF(K1.facility, "1B") }).findings.find((x) => x.messageKey === "R18.use_grade")!;
    expect(findingText(f).endsWith(BY_DECLARATION_NOTE)).toBe(true);
    const plain = evaluate({ ...K1, lines: [...K1.lines, line("C001_N7_MITORI", 1, [day(20)]), line("C001_N8_SHIBOU", 1, [day(20)])] }).findings.find((x) => x.messageKey === "R09.mitori_with_shibou")!;
    expect(findingText(plain)).not.toContain(BY_DECLARATION_NOTE);
  });
});

describe("申告から来た値として渡しても、同梱の症例と練習問題の指摘・合計は変わらない（段 17d）", () => {
  it.each(INPUTS.map((x) => [x.name, x.ctx] as const))("%s", (_, ctx) => {
    const a = evaluate(ctx);
    const b = evaluate({ ...ctx, facilityBasis: declared });
    expect([b.total, b.findings]).toEqual([a.total, a.findings]);
  });
});
