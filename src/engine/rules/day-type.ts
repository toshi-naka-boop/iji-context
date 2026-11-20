// 訪問診療時の区分と再診時等の区分を、その日に算定した行で使い分ける加算のルール（design.md §2-3-1 R08・R15、§2-3-2）。
// ベースアップ評価料(Ⅰ)（R08）と物価対応料（R15）が同じ形なので、工場関数を共有する
import { billedOushinDays, billedVisitDays } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { ClaimContext, FacilityFactKey, Finding, Rule } from "../types";
import { finding, lineOf } from "./util";

export type DayTypeSpec = {
  id: string;
  /** 訪問診療時の区分 */
  visitKubun: string[];
  /** 再診時等の区分 */
  otherKubun: string;
  /** 訪問診療料と往診料の両方を算定した日の重ねを決める施設の設定（加算ごとに別） */
  overlapKey: FacilityFactKey;
  reference: string;
};

export function makeDayTypeRule(spec: DayTypeSpec, c: RevisionConsts): Rule {
  const { visitKubun: VISIT, otherKubun: OTHER, overlapKey } = spec;
  const ALL = [...VISIT, OTHER];
  const visitTypeDays = (ctx: ClaimContext) => new Set(VISIT.flatMap((k) => lineOf(ctx, k)?.dates ?? []));
  /** 訪問診療料と往診料の両方を算定した日のうち、訪問診療時の区分と再診時等の区分が重なっている日 */
  function overlapDays(ctx: ClaimContext): string[] {
    const v = new Set(billedVisitDays(ctx, c));
    const o = new Set(billedOushinDays(ctx, c));
    const vt = visitTypeDays(ctx);
    return (lineOf(ctx, OTHER)?.dates ?? []).filter((d) => v.has(d) && o.has(d) && vt.has(d));
  }
  return {
    id: spec.id,
    kubun: ALL,
    reference: spec.reference,
    recordFindings: [],
    soundWhenPartial: [],
    appliesTo: (ctx) => ALL.some((k) => lineOf(ctx, k)),
    // 重ねた行があるときだけ、施設の設定を聞く
    needs: (ctx) => (overlapDays(ctx).length > 0 ? [`facility.${overlapKey}`] : []),
    check(ctx) {
      const out: Finding[] = [];
      // 「訪問診療の日」は、訪問診療料を算定した日（行の日付）で決める。出来事は見ない
      const v = new Set(billedVisitDays(ctx, c));
      const o = new Set(billedOushinDays(ctx, c));
      const wrongVisit = VISIT.filter((k) => (lineOf(ctx, k)?.dates ?? []).some((d) => !v.has(d)));
      if (wrongVisit.length) out.push(finding(this, "区分誤り", wrongVisit, "oushin_only_day"));
      const otherDays = lineOf(ctx, OTHER)?.dates ?? [];
      // 訪問診療料だけの日の再診時等：その日に訪問診療時の区分がまだなければ置き換え、すでにあれば重複なので外す（置き換えると同じ日に 2 つ残る）
      const vt = visitTypeDays(ctx);
      const onVisitOnly = otherDays.filter((d) => v.has(d) && !o.has(d));
      if (onVisitOnly.some((d) => !vt.has(d))) out.push(finding(this, "区分誤り", [OTHER], "use_visit"));
      if (onVisitOnly.some((d) => vt.has(d))) out.push(finding(this, "背反", [OTHER], "duplicate_on_visit_day"));
      // 両方を算定した日の重ね：設定が偽なら、再診時等の行は算定できないので外す（区分の置き換えにしない）
      const setting = ctx.facility[overlapKey];
      if (overlapDays(ctx).length > 0 && setting.known && setting.value === false) out.push(finding(this, "背反", [OTHER], "no_revisit_on_both_day"));
      return out;
    },
  };
}
