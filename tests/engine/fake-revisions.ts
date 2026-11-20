// 作り物の版（design.md §2-5。FR-92）：点数表に区分 1 つ・ルール 1 つだけの版を 2 つ。改定（generation）も別。
// 版の仕組み（境界・期間の外・重なり・空白）を確かめるためのもので、実在の点数・区分とは無関係
import type { Revision, RevisionConsts } from "../../src/engine/revisions/types";
import type { Rule } from "../../src/engine/types";

/** 回数が上限を超えたら背反を 1 件出すだけのルール。対象区分と上限は版ごとに違う */
function fakeRule(kubun: string, maxCount: number): Rule {
  return {
    id: "F01",
    kubun: [kubun],
    reference: "作り物のルール",
    recordFindings: [],
    appliesTo: (ctx) => ctx.lines.some((l) => l.kubun === kubun),
    needs: () => [],
    check(ctx) {
      const over = ctx.lines.some((l) => l.kubun === kubun && l.count > maxCount);
      return over ? [{ ruleId: this.id, kind: "背反", lineRefs: [kubun], messageKey: "F01.over", reference: this.reference }] : [];
    },
  };
}

export function fakeRevision(over: Partial<Revision> & Pick<Revision, "id" | "effectiveFrom" | "effectiveUntil">, kubun = "X1", unitPoints = 10, maxCount = 1): Revision {
  return {
    label: `作り物の版 ${over.id}`,
    generation: over.id,
    kind: "改定",
    points: { [kubun]: { name: `作り物の区分 ${kubun}`, no: kubun, points: unitPoints, source: "未収載" } },
    consts: {} as RevisionConsts,
    rules: [fakeRule(kubun, maxCount)],
    ...over,
  };
}

/** 2030-01〜2030-12（区分 X1・10 点・1 回まで） */
export const FAKE_A = fakeRevision({ id: "fake-a", effectiveFrom: "2030-01", effectiveUntil: "2030-12" }, "X1", 10, 1);
/** 2031-01〜2031-12（区分 X2・25 点・3 回まで） */
export const FAKE_B = fakeRevision({ id: "fake-b", effectiveFrom: "2031-01", effectiveUntil: "2031-12" }, "X2", 25, 3);
export const FAKE_REVISIONS: Revision[] = [FAKE_A, FAKE_B];
