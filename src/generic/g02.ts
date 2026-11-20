// G02 点数の検算（design.md §12-3）：単位（点数・回数の算定単位）ごとに、1 回分の点数をマスターから再計算し、UKE に書いてある点数と比べる。
// 再計算できる形だけを比べ、できない単位は理由つきで「検算の対象外」に数える（合っているとは数えない）。式と対象外の理由は src/generic/points.ts。
// 点数の書いていない単位（区分キーから作った単位）は、検算しない（数にも入れない）
import { hasRevision, resolveRevision } from "../engine/revisions";
import { pickSnapshot, type MastersDb } from "../masters/db";
import type { UkeComment } from "../uke/types";
import { EXCLUDE_TEXT, recalcUnit, type ExcludeReason, type RecalcBundle } from "./points";
import type { GenericAbout, GenericCheck, GenericClaim, GenericFinding, GenericUnitDetail, RecalcSummary } from "./types";

const MASTER = { SI: "shinryo", IY: "iyakuhin", TO: "tokutei" } as const;
const WHAT = { SI: "診療行為", IY: "医薬品", TO: "特定器材" } as const;

/** 単位 1 つの検算の結果。later＝後の 1 枚で代えていて、使った行の変更年月日が診療年月の末日より後（design.md §12-1） */
export type UnitRecalc =
  | { unit: number; uke: number; status: "match" | "mismatch"; calc: number; formula: string; table: string; codes: string[]; later: boolean }
  | { unit: number; uke: number; status: "excluded"; reason: ExcludeReason };

/** 版の表の包括の検査の群（EM §2-8）を、項目数 → 点数にする。診療年月の版が、使うマスターの世代と違えば、持たない（その群は「表を持っていない」になる） */
function bundlesOf(about: GenericAbout): RecalcBundle[] {
  if (!hasRevision(about.yearMonth)) return [];
  const rev = resolveRevision(about.yearMonth);
  if (rev.generation !== about.generation) return [];
  return rev.bundles.map((b) => ({ members: b.members, tiers: b.tiers.map((t) => ({ min: t.min, points: rev.points[t.kubun].points })) }));
}

/**
 * 請求の単位を全部検算する。診療年月の世代の 1 枚がないマスターがあれば skip（近い世代で代用しない）。
 * 診療識別は、単位の先頭の行にだけ書く（作成手引き 第14章 1(1) ウ）ので、省略された単位は、前の行に書いてある診療識別を引き継ぐ
 */
export function recalcClaim(claim: GenericClaim, masters: MastersDb, about: GenericAbout): UnitRecalc[] | { skip: string } {
  const units = claim.units as GenericUnitDetail[];
  const kinds = new Set(units.filter((u) => typeof u.points === "number").flatMap((u) => u.items.map((it) => it.kind)));
  const pick = { SI: pickSnapshot(masters, "shinryo", about.yearMonth, about.generation), IY: pickSnapshot(masters, "iyakuhin", about.yearMonth, about.generation), TO: pickSnapshot(masters, "tokutei", about.yearMonth, about.generation) };
  for (const kind of kinds) if (pick[kind] === null) return { skip: `診療年月の世代（${about.generation}）の${WHAT[kind]}のマスターがありません` };
  const snapshots = { SI: pick.SI?.snapshot ?? null, IY: pick.IY?.snapshot ?? null, TO: pick.TO?.snapshot ?? null };
  const end = `${about.yearMonth.replace("-", "")}31`;
  const bundles = bundlesOf(about);
  // 同じ群の包括の検査が、同じ日の複数の単位に分かれていれば、項目数が単位からは決まらない
  const split = new Set<number>();
  for (const b of bundles) {
    const holders = units.flatMap((u, i) => (u.items.some((it) => it.kind === "SI" && b.members.includes(it.code)) ? [i] : []));
    for (const i of holders)
      for (const j of holders) {
        const a = units[i].days;
        const c = units[j].days;
        if (i !== j && (!a || !c || a.some((n, d) => n > 0 && (c[d] ?? 0) > 0))) split.add(i);
      }
  }
  // コメントの行（行のコメント欄は、その行と同じ行番号）。コメントレコード（CO）は、行のない行番号のもの
  const commentLines = ((claim as { comments?: UkeComment[] }).comments ?? []).map((c) => c.line);
  const itemLines = new Set(units.flatMap((u) => u.items.flatMap((it) => (it.line !== undefined ? [it.line] : []))));
  const coLines = commentLines.filter((line) => !itemLines.has(line));
  /** 単位の行番号の範囲（行番号のない単位は null） */
  const span = (u: GenericUnitDetail | undefined): [number, number] | null => {
    const at = (u?.items ?? []).flatMap((it) => (it.line !== undefined ? [it.line] : []));
    return at.length > 0 ? [Math.min(...at), Math.max(...at)] : null;
  };
  let current = { shikibetsu: "", line: 0 };
  const out: UnitRecalc[] = [];
  units.forEach((u, i) => {
    const first = u.items[0];
    const own = first?.shikibetsu ?? "";
    // 引き継いだ診療識別は、あいだにコメントレコードがなければ確か（コメントレコードには診療識別が書いてあり得るが、読み取りは保持していない）
    const sure = own !== "" || (first?.line !== undefined && !coLines.some((line) => line > current.line && line < first.line!));
    const shikibetsu = own !== "" ? own : current.shikibetsu;
    for (const it of u.items) if ((it.shikibetsu ?? "") !== "") current = { shikibetsu: it.shikibetsu!, line: it.line ?? 0 };
    if (typeof u.points !== "number" || u.items.length === 0) return;
    if (split.has(i)) {
      out.push({ unit: i, uke: u.points, status: "excluded", reason: "bundleSplit" });
      return;
    }
    // その単位に付いたコメント：行のコメント欄、単位の中のコメントレコード、直前・直後（前の単位の終わりから、次の単位の始まりまで）のコメントレコード
    const from = span(units[i - 1])?.[1] ?? 0;
    const to = span(units[i + 1])?.[0] ?? Infinity;
    const commented = span(u) !== null && commentLines.some((line) => line > from && line < to);
    const r = recalcUnit(masters, snapshots, u.items, { shikibetsu, shikibetsuSure: sure, bundles, commented, count: u.count ?? 1 });
    if ("reason" in r) {
      out.push({ unit: i, uke: u.points, status: "excluded", reason: r.reason });
      return;
    }
    const later = pick[u.items[0].kind]!.later && r.rows.some((row) => row.changedOn > end);
    out.push({ unit: i, uke: u.points, status: r.points === u.points ? "match" : "mismatch", calc: r.points, formula: r.formula, table: r.table, codes: [...new Set(r.rows.map((row) => row.code))], later });
  });
  return out;
}

/** 検算の数（点検の範囲の説明と、scripts/measure-generic.ts が出す） */
export function recalcSummary(list: UnitRecalc[]): RecalcSummary {
  const excluded = new Map<ExcludeReason, number>();
  for (const r of list) if (r.status === "excluded") excluded.set(r.reason, (excluded.get(r.reason) ?? 0) + 1);
  return {
    units: list.length,
    checked: list.filter((r) => r.status !== "excluded").length,
    matched: list.filter((r) => r.status === "match").length,
    excluded: [...excluded].map(([reason, count]) => ({ reason, text: EXCLUDE_TEXT[reason], count })),
  };
}

/** 後の 1 枚で点検していて、使った行の変更年月日が診療年月の末日より後のときに、指摘の文の終わりに添える（design.md §12-1） */
export const LATER_NOTE = "。この後にマスターが変更されています";

export const g02: GenericCheck = {
  id: "G02",
  kind: "点数",
  run(claim, masters, about) {
    const list = recalcClaim(claim, masters, about);
    if (!Array.isArray(list)) return list;
    const out: GenericFinding[] = [];
    for (const r of list) {
      if (r.status !== "mismatch") continue;
      out.push({
        check: "G02",
        kind: "点数",
        certainty: r.later ? "条件つき" : "確定",
        units: [r.unit],
        codes: r.codes,
        messageKey: "G02.points",
        params: { uke: String(r.uke), calc: String(r.calc), formula: r.formula, later: r.later ? LATER_NOTE : "" },
        source: { data: r.table, ref: r.codes.map((code) => `code=${code}`).join(", ") },
      });
    }
    return out;
  },
};
