// trial(claim, rev)：版を名指しして、試しに判定する（design.md §11-12）。請求の判定（evaluate。版は診療年月で決まる）とは別の道。
// 試算の結果は記録に使わない：型を EngineResult と分け、提出の確定・適用記録・防いだ額・知識の USED の入口には渡せない形にする。保存もしない
import { evaluateWith } from "./index";
import type { Revision } from "./revisions/types";
import type { ClaimContext, EngineResult } from "./types";

/**
 * 試算の結果。EngineResult にある revisionId（判定に使った版）と applied（当たったルール。適用記録と USED の元）は持たない。
 * この 2 つがないので、EngineResult を受ける場所に渡すと型で通らず、適用記録の入力（Evaluation）にも詰め替えられない
 */
export type TrialResult = Omit<EngineResult, "revisionId" | "applied"> & {
  /** inPeriod は、診療年月がその版の適用期間に入っているか（外なら、画面の文で示す） */
  trial: { revisionId: string; claimYearMonth: string; inPeriod: boolean };
  /** その版がルールを持っているか。偽の版（比較用の版）は、算定行と点数だけ（「指摘なし」とは言えない） */
  rulesAvailable: boolean;
};

/**
 * 算定行の決まった請求を、渡された版の点数表とルールで試算する。日付は記録のまま動かさない。
 * カルテからの試算は、呼び出し側が deriveLines(input, rev) で導出した行を入れて渡す
 */
export function trial(claim: ClaimContext, rev: Revision): TrialResult {
  const { revisionId, applied: _applied, ...rest } = evaluateWith(claim, rev);
  return {
    ...rest,
    trial: { revisionId, claimYearMonth: claim.yearMonth, inPeriod: rev.effectiveFrom <= claim.yearMonth && claim.yearMonth <= rev.effectiveUntil },
    rulesAvailable: rev.rules.length > 0,
  };
}
