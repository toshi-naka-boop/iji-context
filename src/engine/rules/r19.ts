// R19 単一建物の人数（design.md §15-4。段 17f）：管理料の行の人数の区分（EM R8-94）と、その患者の人数の区分（buildingBandOf）を比べる。
// 人数の次元だけを見る（区分〔回数・重症〕は R01・R02、族は R16、種別は R18 の担当。§0-12）。行と申告・確かめた事実と摘要欄のみなしのコメントで決まる（出来事は読まない）
import { buildingBandOf, kanriKubun, kanriKubunOf, kanriLines, reducedOf } from "../predicates";
import { NOTE14_BANDS, type BuildingBand } from "../types";
import { note14Either } from "./r18";
import type { KanriRow, KubunDef, RevisionConsts } from "../revisions/types";
import type { ClaimContext, Finding, Rule } from "../types";
import { finding } from "./util";

/** 単一建物診療患者の人数のみなしのコメント（EM §2-2 R8-192）：戸数によるもの（在医総管を 1 人の区分で請求する根拠。留意 C002 (11)） */
export const MINASHI_UNITS = ["820100095", "820100096"] as const;
/** ユニット数によるもの（人数をユニットで数える根拠。区分は 1 人とは限らない）。R19 は、確かめた人数の区分と比べる（特別な扱いはしない） */
export const MINASHI_UNIT_COUNT = "820100094";

/** その行に付いた（行の単位にあるか、レセプト全体の）戸数によるみなしのコメントがあるか */
export function minashiOn(ctx: Pick<ClaimContext, "comments" | "commentsKnown">, kubun: string): boolean {
  if (!ctx.commentsKnown) return false;
  return (ctx.comments ?? []).some((x) => (MINASHI_UNITS as readonly string[]).includes(x.code) && (x.on.length === 0 || x.on.includes(kubun)));
}

/**
 * 戸数によるみなしで 1 人と読んだ在医総管の 1 人の区分の行（R19 が何も言わない行。点検の範囲に「みなしのコメントで 1 人と読んだ行：n 行」と出す）
 */
export function minashiOneLines(ctx: ClaimContext, c: RevisionConsts): string[] {
  return kanriLines(ctx, c)
    .filter((l) => l.family === "在医総管" && l.band === undefined && minashiOn(ctx, l.kubun))
    .map((l) => l.kubun);
}

/** points は版の点数表（直し先の区分の名前を文に添えるのに使う。点数は見ない） */
export function makeR19(c: RevisionConsts, points: Record<string, KubunDef>): Rule {
  const named = (fix: string) => ({ fix, fixName: points[fix]?.name ?? fix, fixText: `人数の区分に合う区分は「${points[fix]?.name ?? fix}」です` });
  /**
   * 直し先の名称（round-57 C-324・round-58 C-332。L-148）：直し先が 10 人以上でなければ、その人数の区分の行（注14 の側を持たない）。
   * 10 人以上なら、申告 note14 が 減算 → 減の行（1 つに決まらなければ両方。L-151）、通常 → 通常の行（ただし請求の行が減の行なら減の行のまま。申告だけで点数の高い側を名指ししない。L-130）、
   * 分からない → 名称を添えず「注14 の申告によって通常の行か減の行のどちらかです」。名称が申告で変わるので、use_band は byDeclaration に載る
   */
  function fixParams(ctx: ClaimContext, l: { kubun: string; family: KanriRow["family"]; grade: KanriRow["grade"]; tier: KanriRow["tier"]; note14?: KanriRow["note14"] }, band: BuildingBand): Record<string, string> {
    const normal = kanriKubunOf(c, l.family, l.grade, l.tier, band);
    if (!normal) return { fixText: "" };
    if (!NOTE14_BANDS.includes(band) || !c.kanri.note14Pairs) return named(normal);
    const n = ctx.facility.note14;
    const reds = reducedOf(c, normal);
    const sameSide = reds.find((k) => c.kanri.rows.find((r) => r.kubun === k)?.note14 === l.note14);
    if (n.known && n.value === "減算") {
      if (reds.length === 1) return named(reds[0]);
      const e = note14Either(reds, points);
      return { fixes: e.fixes, fixName: e.fixName, fixText: `人数の区分に合う区分は「${e.fixName}」です${e.note8}` };
    }
    if (n.known && n.value === "通常") return l.note14 !== undefined && sameSide ? named(sameSide) : named(normal);
    return { fixText: "人数の区分に合う区分は、注14 の申告によって通常の行か減の行のどちらかです" };
  }
  return {
    id: "R19",
    kubun: kanriKubun(c),
    reference: "C002 注1・C002-2 注1（単一建物診療患者の人数による区分）・留意事項 C002 (3)・(11)",
    recordFindings: [],
    // その行と申告・確かめた事実だけで決まる（ほかの行の有無に依らない。§11-11・§12-4）
    soundWhenPartial: ["use_band"],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => kanriLines(ctx, c).length > 0,
    // 分からない人数は、check が情報不足で返す（みなしのコメントで決まる行があるため）
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const read = buildingBandOf(ctx);
      const unknownLines: string[] = [];
      const conflict: string[] = [];
      for (const l of kanriLines(ctx, c)) {
        const lineBand = l.band ?? "1";
        // 戸数によるみなし：在医総管の 1 人の区分の行は、みなしで 1 人と読める（言わない）。2 人以上の区分の行に付いたら、人数を確かめてもらう
        if (minashiOn(ctx, l.kubun)) {
          if (l.family === "在医総管" && lineBand === "1") continue;
          unknownLines.push(l.kubun);
          continue;
        }
        if (!read.known) {
          unknownLines.push(l.kubun);
          continue;
        }
        if (read.value === lineBand) continue;
        // 施設の申告（2 人以上の建物はない）だけから 1 人と決まり、行が 2 人以上の区分：点数の高い区分へ直さず、申告と請求の食い違いにする（C-251。L-126）
        if (read.byDeclaration) {
          conflict.push(l.kubun);
          continue;
        }
        out.push({ ...finding(this, "区分誤り", [l.kubun], "use_band"), params: fixParams(ctx, l, read.value) });
      }
      if (conflict.length) out.push({ ruleId: this.id, kind: "情報不足", lineRefs: conflict, missing: { target: "clerk", field: "facility.building" }, messageKey: `${this.id}.declaration_conflict`, reference: this.reference });
      if (unknownLines.length) {
        const facilityFirst = read.known === false && read.facilityFirst;
        out.push({
          ruleId: this.id,
          kind: "情報不足",
          lineRefs: unknownLines,
          missing: { target: "clerk", field: "buildingBand" },
          messageKey: `${this.id}.missing_fact`,
          reference: this.reference,
          ...(facilityFirst ? { params: { facilityFirst: "1" } } : {}),
        });
      }
      return out;
    },
  };
}
