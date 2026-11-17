// 値の変更の版を、直前の版との差分から作る（design.md §2-5。FR-147）
// 上書きできるのは既存の区分の点数だけ。区分の追加・定数・ルールの変更はできない（直前の版のファイルは変えない）
import type { Revision } from "./types";

export type RevisionDiff = Pick<Revision, "id" | "label" | "effectiveFrom" | "effectiveUntil"> & { points: Record<string, number> };

export function extendRevision(base: Revision, diff: RevisionDiff): Revision {
  const points = { ...base.points };
  for (const [kubun, p] of Object.entries(diff.points)) {
    if (!Object.hasOwn(base.points, kubun)) throw new Error(`値の変更の版 ${diff.id}：直前の版にない区分は足せない: ${kubun}`);
    points[kubun] = { ...base.points[kubun], points: p };
  }
  return {
    id: diff.id,
    label: diff.label,
    generation: base.generation,
    kind: "値の変更",
    effectiveFrom: diff.effectiveFrom,
    effectiveUntil: diff.effectiveUntil,
    points,
    consts: base.consts,
    rules: base.rules,
  };
}
