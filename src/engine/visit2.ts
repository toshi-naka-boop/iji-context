// 訪問診療料(Ⅰ)2 の扱い（design.md §18-12 の 8。EM §2-14 R8-288〜R8-304。2026-11-24 承認）。ルールと導出が共有する小道具。
// 在医総管の区分の回数（R01・R02・R03・D03）・週の上限（R13・R17 T167）は (Ⅰ)1 だけで数える（W-112・W-118・W-119）。
// 訪問診療の日として数えるのは R08・R15・R10・R11・D02・D06〜D08（W-115〜W-117・W-122〜W-125）。R17 の T176 は決められないのまま（記載要領は未確認）
import type { Revision, RevisionConsts } from "./revisions/types";
import type { ClaimContext, Rule } from "./types";

/** 請求に (Ⅰ)2 の行があるか */
export const hasVisit2 = (lines: ClaimContext["lines"], c: Pick<RevisionConsts, "visit2Kubun">): boolean => lines.some((l) => l.count > 0 && (c.visit2Kubun ?? []).includes(l.kubun));

/** (Ⅰ)2 も訪問診療料として数える定数の見方（visitKubun に (Ⅰ)2 を足す。[(Ⅰ)1 イ, (Ⅰ)1 ロ, (Ⅰ)2 イ, (Ⅰ)2 ロ]） */
export const withVisit2Kubun = (c: RevisionConsts): RevisionConsts => ({ ...c, visitKubun: [...c.visitKubun, ...(c.visit2Kubun ?? [])] });

/** (Ⅰ)1・(Ⅰ)2 の回数 */
export function visitCounts(ctx: Pick<ClaimContext, "lines">, c: RevisionConsts): { v1: number; v2: number } {
  const sum = (ks: string[]) => ctx.lines.filter((l) => ks.includes(l.kubun)).reduce((n, l) => n + l.count, 0);
  return { v1: sum(c.visitKubun), v2: sum(c.visit2Kubun ?? []) };
}

/** 同じ月に (Ⅰ)1 と (Ⅰ)2 の両方がある月（U-67：R01〜R03・T176 は判定不能。事情は R01 が患者・月ごとに 1 回だけ聞く） */
export const mixedVisitMonth = (ctx: Pick<ClaimContext, "lines">, c: RevisionConsts): boolean => {
  const { v1, v2 } = visitCounts(ctx, c);
  return v1 > 0 && v2 > 0;
};

/** (Ⅰ)2 の行の有無で指摘が変わるルール（reads に (Ⅰ)2 を足す。design.md §12-4） */
export const VISIT2_READERS = ["R01", "R02", "R03", "R08", "R09", "R10", "R11", "R15", "R17"];

export function withVisit2Reads(rules: Rule[], rev: Pick<Revision, "consts">): Rule[] {
  const v2 = rev.consts.visit2Kubun ?? [];
  return rules.map((r) => {
    if (!VISIT2_READERS.includes(r.id) || v2.length === 0) return r;
    const orig = r.reads!;
    return { ...r, reads: (x: Revision) => [...new Set([...orig.call(r, x), ...v2])] };
  });
}

/** 確定の指摘にしない R09 の加算の月の文（U-72。医療事務には聞かず、厚生局への照会の候補） */
export const VISIT2_TERMINAL_NOTE = "訪問診療料(Ⅰ)2 だけの月の在宅ターミナルケア加算・看取り加算・死亡診断加算は見ていません（前月の (Ⅰ)1・死亡日の往診で読みが割れます。厚生局への照会の候補です）";

/**
 * (Ⅰ)2 だけの月に C001 の看取り加算・死亡診断加算・在宅ターミナルケア加算の行がある月の読み（EM §2-14 W-120・W-128・U-72）。
 * "wrong"：前の月に (Ⅰ)1 がなく、加算の日（死亡日）に往診料もない → 付く先の誤り（確定）。"unseen"：それ以外（前の月を取り込んでいない・前の月に (Ⅰ)1 がある・死亡日に往診）→ 見ていません。null：当たらない
 */
export function visit2Terminal(ctx: Pick<ClaimContext, "lines" | "prevMonthVisit1">, c: RevisionConsts): { verdict: "wrong" | "unseen"; refs: string[] } | null {
  const { v1, v2 } = visitCounts(ctx, c);
  if (v1 > 0 || v2 === 0) return null;
  const adds = [c.terminal.mitori, c.terminal.shibou, ...Object.values(c.terminal.terminal)];
  const mine = ctx.lines.filter((l) => l.count > 0 && adds.includes(l.kubun));
  if (mine.length === 0) return null;
  const days = new Set(mine.flatMap((l) => l.dates));
  const oushinOnDeath = ctx.lines.some((l) => l.kubun === c.oushin.kubun && l.count > 0 && l.dates.some((d) => days.has(d)));
  return { verdict: ctx.prevMonthVisit1 === false && !oushinOnDeath ? "wrong" : "unseen", refs: mine.map((l) => l.kubun) };
}

/** (Ⅰ)2 で見ていないことの点検の範囲の文 */
export function visit2ScopeNotes(ctx: Pick<ClaimContext, "lines" | "prevMonthVisit1">, c: RevisionConsts): string[] {
  return visit2Terminal(ctx, c)?.verdict === "unseen" ? [VISIT2_TERMINAL_NOTE] : [];
}
