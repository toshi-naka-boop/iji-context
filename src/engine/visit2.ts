// 訪問診療料(Ⅰ)2 の当面の扱い（design.md §18-12 の 8。正しい扱いは EM の追記〔sources/em-v38-draft.md。未承認〕の承認のあとに入れる）。
// 一次資料の調べで、今の読みが (Ⅰ)2 の日を誤って扱うと分かったルールだけを、(Ⅰ)2 の行がある請求では、版に足す前と同じ「決められない」に置く：
// (Ⅰ)2 の行をそのルールに渡さず、partial として判定する（申告のある種類の指摘だけを出し、ほかは情報不足 unsupportedLines）。
// 在医総管の区分の回数（R01・R02・R03・D03）・週の上限（R13・R17 T167）は (Ⅰ)1 だけで数えるので、今のまま（留意 C002 (4)。em-v38-draft.md §2）。
// R17 は、在医総管の月の訪問日の記載（T176）だけを決められないに置く（rules/r17.ts）
import type { Revision } from "./revisions/types";
import type { ClaimContext, Rule } from "./types";

/**
 * (Ⅰ)2 の行で決められないに置くルール（em-v38-draft.md §2「ルールごとの扱い」）：
 * R08・R15（(Ⅰ)2 の日は訪問診療時の区分。留意 O001 (4)(5)）、R10（同じ日の往診料・再診料）、R09（看取り・ターミナルケアの回数と加算）
 */
export const VISIT2_HELD_RULES = ["R08", "R09", "R10", "R15"];
/** 決められないに置く R17 の記載（在医総管の月の往診・訪問診療の年月日。記載要領は未確認） */
export const VISIT2_HELD_COMMENTS = ["T176-date"];
/** 導出のうち、(Ⅰ)2 の行がある入力で決められないに置くもの（D01 訪問診療料・D02 往診料と再診料・D06 DX 加算・D07 ベースアップ評価料・D08 物価対応料・D12 在宅ターミナルケア加算） */
export const VISIT2_HELD_DERIVES = ["D01", "D02", "D06", "D07", "D08", "D12"];

/** 請求に (Ⅰ)2 の行があるか */
export const hasVisit2 = (lines: ClaimContext["lines"], c: Revision["consts"]): boolean => lines.some((l) => l.count > 0 && (c.visit2Kubun ?? []).includes(l.kubun));

export const heldByVisit2 = (rule: Rule, rev: Pick<Revision, "consts">): boolean => (rev.consts.visit2Kubun ?? []).length > 0 && VISIT2_HELD_RULES.includes(rule.id);

/** (Ⅰ)2 の行がある請求で、そのルールに渡す請求（(Ⅰ)2 の行を除き、partial にする）。当たらなければそのまま */
export function forVisit2(ctx: ClaimContext, rule: Rule, rev: Revision): ClaimContext {
  if (!heldByVisit2(rule, rev) || !hasVisit2(ctx.lines, rev.consts)) return ctx;
  const v2 = rev.consts.visit2Kubun ?? [];
  return { ...ctx, lines: ctx.lines.filter((l) => !v2.includes(l.kubun)), partial: true };
}

/** 決められないに置くルール（と R17）の reads に (Ⅰ)2 を足す（(Ⅰ)2 の行の有無で指摘が変わるので、読む区分として申告する。design.md §12-4） */
export function withVisit2Reads(rules: Rule[], rev: Pick<Revision, "consts">): Rule[] {
  const v2 = rev.consts.visit2Kubun ?? [];
  return rules.map((r) => {
    if (!heldByVisit2(r, rev) && r.id !== "R17") return r;
    const orig = r.reads!;
    return { ...r, reads: (x: Revision) => [...new Set([...orig.call(r, x), ...v2])] };
  });
}
