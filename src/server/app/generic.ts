// データで動く点検（design.md §12-2・§12-5）を、区分キーの算定行に掛ける：月末の点検（行を入力する問題）と、カルテの算定プレビュー。
// 区分を codes[kubun].primary でコードに直してから、取り込んだレセプトの点検と同じ関数（evaluateGeneric）に渡す。読むだけで、何も記録しない。
// 指摘は、手書きのルールの結果との重なりの規則（src/generic/overlap.ts）を通してから出す
import type { Revision } from "../../engine/revisions/types";
import type { ClaimLine, EngineResult } from "../../engine/types";
import type { DeclarationView } from "../../facility/declaration";
import { evaluateGeneric } from "../../generic";
import { g10MarksOf, sidelessOf } from "../../generic/g10";
import { rowNamesOf, type RowNames } from "../../generic/lookup";
import { claimOfLines, overlap, type MappedLine } from "../../generic/overlap";
import { deferredNote, genericScopeOf } from "../../generic/scope";
import type { GenericAbout, GenericResult } from "../../generic/types";
import { genericView, type GenericView } from "../../generic/view";
import { withMasters } from "../../masters/db";

/** 手書きのルールの結果のうち、重なりの規則が読むもの（試算の結果は applied を持たない） */
export type Hand = Pick<EngineResult, "findings"> & { applied?: string[] };

/** overlap は、重なりの規則で出さなかった指摘の数：duplicate＝手書きの指摘と同じことなので出さなかった／judged＝手書きのルールが判定済みなので止めた */
export type GenericOut = GenericView & { overlap: { duplicate: number; judged: number } };

/** データで動く点検の結果に、重なりの規則を通して、画面に出す形にする */
export function genericOut(result: GenericResult, names: RowNames | null, hand: Hand, rev: Revision, recordsKnown: boolean, mapped: MappedLine[]): GenericOut {
  const o = overlap(hand, rev, recordsKnown, mapped, result.findings);
  return { ...genericView({ ...result, findings: o.findings }, names), overlap: { duplicate: o.duplicate, judged: o.judged } };
}

/**
 * skippedLines は、コードに直せないので掛けなかった行の数（コードを持たない区分と、包括の検査の区分）。hand は、同じ行を手書きのルールで判定した結果。
 * local は、背反の組の院内の知識と本人のレベル（design.md §14-3。月末の点検・算定プレビューが渡す。試算は渡さない）。localUsed は、指摘に添えた承認済みの知識の id。
 * declaration は、施設の申告の三値（G10。design.md §15-5。月末の点検・算定プレビューが渡す。試算は渡さない＝G10 は動かない）
 */
export function genericOfLines(lines: ClaimLine[], rev: Revision, yearMonth: string, hand: Hand, recordsKnown: boolean, local?: Pick<GenericAbout, "localKnowledge" | "level">, declaration?: DeclarationView): GenericOut & { skippedLines: number; localUsed: string[] } {
  const { claim, mapped } = claimOfLines(lines, rev);
  const about: GenericAbout = { yearMonth, generation: rev.generation, ...local, ...(declaration ? { declaration, sideless: sidelessOf(rev) } : {}) };
  const view = withMasters((db) => {
    const result = evaluateGeneric(claim, db, about);
    // 入力した行には、点数も、患者・施設の情報もない。検算（G02）と行の属性（G03）のうち、していないことを点検の範囲に出す
    const scope = genericScopeOf(claim, db, about, result);
    // C〜I に回した区分の「見ていない」（design.md §15-4。L-92）も、同じ点検の範囲に出す
    const deferred = deferredNote(lines, rev);
    // 施設基準の印は、G10 が動いたときだけ（動かなければ「届出が要ります」のまま。design.md §15-5）
    const marks = db && result.ran.some((r) => r.check === "G10") ? g10MarksOf(claim, db, about) : null;
    return { ...genericOut(result, db ? rowNamesOf(db, about, { items: claim.units.flatMap((u) => u.items), comments: [], diseases: [] }, marks) : null, hand, rev, recordsKnown, mapped), scope: deferred ? { ...scope, notDone: [...scope.notDone, deferred] } : scope, localUsed: result.localUsed ?? [] };
  });
  // 回数 0 の行は、算定していない行なので「掛けなかった行」に数えない
  return { ...view, skippedLines: lines.filter((l) => l.count > 0).length - claim.units.length };
}
