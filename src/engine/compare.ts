// compareRevisions(input, from, to)：同じ出来事と事実を 2 つの版で導出して並べる（design.md §11-2）。
// 比べるのは導出（deriveLines）だけで、ルールの指摘（evaluate）は比べない。ルールの違いは、後の版の changes の文で見せる。
// 診療年月は入力のまま変えず、版だけを替える。実際にその年度に請求した結果ではない
import { deriveLines, type DeriveInput, type DeriveResult, type Pending, type Unsupported } from "./derive";
import { kanriOf } from "./predicates";
import type { Revision } from "./revisions/types";
import type { ClaimLine } from "./types";

/** 片方の版の 1 行。tentative は、導出の保留つき（月の途中の見込みか、保留がこの区分を待たせていて、回数がまだ変わり得る） */
export type Side = { kubun: string; name: string; count: number; points: number | null; subtotal: number | null; tentative: boolean };
/**
 * 新設・廃止は、その区分が片方の版の点数表にないとき。点数表にはあるが行が立たなかった側（保留・未対応・導出の違い）は「回数」とし、新設・廃止とは言わない
 */
export type CompareChange = "新設" | "廃止" | "区分の変更" | "点数" | "回数" | "同じ";
export type CompareRow = { group: string; from: Side | null; to: Side | null; change: CompareChange };
export type CompareResult = {
  rows: CompareRow[];
  /** 保留・未対応・点数未収載があれば null */
  totals: { from: number | null; to: number | null };
  pending: { from: Pending[]; to: Pending[] };
  /** その版では導出しなかったもの（合計を出さない理由） */
  unsupported: { from: Unsupported[]; to: Unsupported[] };
  /** to.changes のうち、rows の区分か、rows の区分を対象にするルールに関わるもの */
  changes: Revision["changes"];
};

/** 手入力の行（導出しない区分の行）を、その版の点数表にある区分だけに絞る。落ちた区分は、その版では行なしになる */
export function manualIn(manual: ClaimLine[], rev: Revision): ClaimLine[] {
  return manual.filter((l) => Object.hasOwn(rev.points, l.kubun));
}

type Derived = { rev: Revision; result: DeriveResult; sides: Side[] };

function derive(input: DeriveInput, rev: Revision): Derived {
  const result = deriveLines({ ...input, manual: manualIn(input.manual, rev) }, rev);
  const held = new Set(result.pending.flatMap((p) => p.blocks));
  const sides: Side[] = [];
  result.lines.forEach((l, i) => {
    const same = sides.find((s) => s.kubun === l.kubun);
    const tentative = (result.basis[i]?.tentative ?? false) || held.has(l.kubun);
    if (same) {
      // 同じ区分の行（手入力で分けて入れたもの）は 1 行にまとめる
      same.count += l.count;
      same.subtotal = same.points === null ? null : same.points * same.count;
      same.tentative ||= tentative;
      return;
    }
    const def = rev.points[l.kubun];
    sides.push({ kubun: l.kubun, name: def.name, count: l.count, points: def.points, subtotal: def.points === null ? null : def.points * l.count, tentative });
  });
  return { rev, result, sides };
}

/** 行のまとめの単位：管理料は族（在医総管・施設総管）、ほかは区分キー */
const groupOf = (d: Derived, kubun: string): string => kanriOf(d.rev.consts, kubun)?.family ?? kubun;

const totalOf = (d: Derived): number | null =>
  d.result.totalStatus === "withheld" || d.sides.some((s) => s.subtotal === null) ? null : d.sides.reduce((sum, s) => sum + (s.subtotal as number), 0);

export function compareRevisions(input: DeriveInput, from: Revision, to: Revision): CompareResult {
  const a = derive(input, from);
  const b = derive(input, to);
  const has = (rev: Revision, kubun: string) => Object.hasOwn(rev.points, kubun);

  const rows: CompareRow[] = [];
  // 並びは、後の版の行の順。後の版に行のない区分は、前の版の順で後ろに足す
  const groups = [...new Set([...b.sides.map((s) => groupOf(b, s.kubun)), ...a.sides.map((s) => groupOf(a, s.kubun))])];
  for (const group of groups) {
    const fromSides = a.sides.filter((s) => groupOf(a, s.kubun) === group);
    const toSides = b.sides.filter((s) => groupOf(b, s.kubun) === group);
    // 同じ区分どうしを先に組にする
    for (const t of [...toSides]) {
      const f = fromSides.find((s) => s.kubun === t.kubun);
      if (!f) continue;
      fromSides.splice(fromSides.indexOf(f), 1);
      toSides.splice(toSides.indexOf(t), 1);
      rows.push({ group, from: f, to: t, change: f.points !== t.points ? "点数" : f.count !== t.count ? "回数" : "同じ" });
    }
    // 残りが両側に 1 つずつなら、区分が替わったもの（管理料の族）。「廃止」と「新設」の 2 行に分けない
    if (fromSides.length === 1 && toSides.length === 1) {
      rows.push({ group, from: fromSides[0], to: toSides[0], change: "区分の変更" });
      continue;
    }
    for (const t of toSides) rows.push({ group, from: null, to: t, change: has(from, t.kubun) ? "回数" : "新設" });
    for (const f of fromSides) rows.push({ group, from: f, to: null, change: has(to, f.kubun) ? "回数" : "廃止" });
  }

  const kubun = new Set(rows.flatMap((r) => [r.from?.kubun, r.to?.kubun]).filter((k): k is string => k !== undefined));
  const touches = (ks: string[] | undefined) => (ks ?? []).some((k) => kubun.has(k));
  const changes = to.changes.filter((c) => touches(c.target.kubun) || touches(to.rules.find((r) => r.id === c.target.ruleId)?.kubun));

  return {
    rows,
    totals: { from: totalOf(a), to: totalOf(b) },
    pending: { from: a.result.pending, to: b.result.pending },
    unsupported: { from: a.result.unsupported, to: b.result.unsupported },
    changes,
  };
}
