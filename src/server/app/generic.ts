// データで動く点検（design.md §12-2・§12-5）を、区分キーの算定行に掛ける：月末の点検（行を入力する問題）と、カルテの算定プレビュー。
// 区分を codes[kubun].primary でコードに直してから、取り込んだレセプトの点検と同じ関数（evaluateGeneric）に渡す。読むだけで、何も記録しない
import type { Revision } from "../../engine/revisions/types";
import type { ClaimLine } from "../../engine/types";
import { evaluateGeneric, unitsOfLines } from "../../generic";
import { rowNamesOf } from "../../generic/lookup";
import { genericView, type GenericView } from "../../generic/view";
import { withMasters } from "../../masters/db";

/** skippedLines は、コードに直せないので掛けなかった行の数（コードを持たない区分と、包括の検査の区分） */
export function genericOfLines(lines: Pick<ClaimLine, "kubun">[], rev: Revision, yearMonth: string): GenericView & { skippedLines: number } {
  const claim = unitsOfLines(lines, rev);
  const about = { yearMonth, generation: rev.generation };
  const view = withMasters((db) => genericView(evaluateGeneric(claim, db, about), db ? rowNamesOf(db, about, { items: claim.units.flatMap((u) => u.items), comments: [], diseases: [] }) : null));
  return { ...view, skippedLines: lines.length - claim.units.length };
}
