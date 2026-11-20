// 段 12（G04 包括・G05 背反・G06 算定回数。design.md §12-3）が共通で使うもの：電子点数表の 1 枚と行の選び方、単位の中の診療行為の数え方。
// 表と列の意味は src/masters/layout.ts（[点]＝医科電子点数表の活用手引き 令和8年度版）。表の名前は、指摘の出どころ（source.data）にそのまま出す
import { pickSnapshot, sourcesOf, type MastersDb } from "../masters/db";
import type { GenericAbout, GenericClaim } from "./types";

/**
 * G04〜G06 が読む、単位の回数と算定日（1〜31 日の回数）。parseUke の UkeUnit は、そのまま当たる。
 * 持たない単位（算定日の分からない行）は、日・週で決まる点検には掛けない（月で決まる点検には、回数 1 として掛ける）
 */
export type GenericTiming = { count?: number; days?: number[] };
/** 算定日つきの請求（GenericClaim として evaluateGeneric に渡せる） */
export type TimedClaim = { units: (GenericClaim["units"][number] & GenericTiming)[] };

/** 電子点数表の 1 行が持つ、行の異動と新設・廃止の年月日（[点] p25〜30。どの表も同じ形） */
export type Dated = { change: string; created_on: string; abolished_on: string };

/** 指摘の出どころに出す表の名前（[点] p6〜7 の呼び名） */
export const TABLE = {
  hojo: "医科診療行為マスター補助マスターテーブル",
  houkatsu: "包括・被包括テーブル",
  haihan: { 1: "背反関連テーブル（1 日につき）", 2: "背反関連テーブル（同一月内）", 3: "背反関連テーブル（同時）", 4: "背反関連テーブル（1 週間につき）" } as Record<number, string>,
  kaisu: "算定回数テーブル",
  shinryo: "医科診療行為マスター",
} as const;

/**
 * 診療年月に使う電子点数表の 1 枚と、行の選び方（design.md §12-1「版と履歴」）。その世代の 1 枚がなければ null（近い世代で代用しない）。
 * live＝診療年月に有効な行（新設年月日が月の末日以前、廃止年月日が月の初日以後。抹消の行は使わない）。
 * weak＝有効でも言い切れない行：月の途中で新設・廃止された行と、診療年月より後の 1 枚で代えているときの「変更」の行（いつ変わったかがデータにない）
 */
export function tensuhyoOf(db: MastersDb, about: GenericAbout): { snapshot: string; live(r: Dated): boolean; weak(r: Dated): boolean } | null {
  const pick = pickSnapshot(db, "tensuhyo", about.yearMonth, about.generation);
  if (pick === null) return null;
  const ym = about.yearMonth.replace("-", "");
  const [start, end] = [`${ym}01`, `${ym}31`];
  return {
    snapshot: pick.snapshot,
    live: (r) => r.change !== "1" && r.created_on <= end && r.abolished_on >= start,
    weak: (r) => r.created_on > start || r.abolished_on < end || (pick.later && r.change === "5"),
  };
}

/** 動かせないときの理由（GenericCheck.run の skip） */
export const noTensuhyo = (about: GenericAbout) => ({ skip: `診療年月の世代（${about.generation}）の電子点数表がありません` });

/** 電子点数表の 1 枚についての断り書き（src/generic/lookup.ts の sheetNotesOf と同じ意味。later＝診療年月より後の 1 枚で代えている、newer＝読み方を確かめた版より新しい） */
export function tensuhyoNotesOf(db: MastersDb, about: GenericAbout): { later: boolean; newer: boolean } {
  const pick = pickSnapshot(db, "tensuhyo", about.yearMonth, about.generation);
  if (pick === null) return { later: false, newer: false };
  return { later: pick.later, newer: sourcesOf(db).some((s) => s.dataset === "tensuhyo" && s.snapshot === pick.snapshot && s.verified !== null && s.snapshot > s.verified) };
}

/**
 * 診療行為のコード 1 つが、請求のどこに何回あるか。units＝そのコードのある単位（並びの順）、month＝回数の合計（単位の回数。持たない単位は 1）、
 * days＝1〜31 日の回数（添字 0 が 1 日）。timed が偽＝算定日を持たない単位がある（日・週で決まる点検には掛けない）。
 * 数え方は、手引きに定めがないので少なく数える側：同じ単位に同じコードが 2 行あっても 1 回分、きざみの数量データは回数に数えない
 */
export type Occurrence = { units: number[]; month: number; days: number[]; timed: boolean };

/** 請求の診療行為（SI）のコードごとの、ある場所と回数。医薬品・特定器材の行は数えない（電子点数表は診療行為の表） */
export function occurrencesOf(claim: GenericClaim): Map<string, Occurrence> {
  const out = new Map<string, Occurrence>();
  (claim as TimedClaim).units.forEach((u, i) => {
    const timed = u.days !== undefined && u.days.some((n) => n > 0);
    for (const code of new Set(u.items.filter((it) => it.kind === "SI").map((it) => it.code))) {
      const o = out.get(code) ?? { units: [], month: 0, days: Array.from({ length: 31 }, () => 0), timed: true };
      o.units.push(i);
      o.month += u.count ?? 1;
      if (timed) u.days!.slice(0, 31).forEach((n, d) => (o.days[d] += n));
      else o.timed = false;
      out.set(code, o);
    }
  });
  return out;
}

/** 2 つのコードが両方ある日（1〜31）。どちらかが算定日を持たなければ空 */
export const commonDays = (a: Occurrence, b: Occurrence): number[] => (a.timed && b.timed ? a.days.flatMap((n, d) => (n > 0 && b.days[d] > 0 ? [d + 1] : [])) : []);

/** 2 つのコードのどちらかがある単位（並びの順。重複なし） */
export const unitsOf = (...os: Occurrence[]): number[] => [...new Set(os.flatMap((o) => o.units))].sort((x, y) => x - y);

/** 指摘の値にする日の並び（"3・17"） */
export const daysText = (days: number[]): string => days.join("・");
