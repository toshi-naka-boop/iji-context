// 査定・返戻の突き合わせの報告（spec FR-202 の I-1。design/iji-context/plan-i1.md「利用者の判断」1・2）。
// 数える単位は増減点の明細の件数を主にし、レセプトの件数を並べる。割合は出さない。減点の点数の合計は社内の報告にだけ並べる。
// 回は点検のコードの指紋で分ける：同じ明細を別の指紋で判定し直したら、それぞれの回に数える（回の中では、その指紋での最後の判定）
import type { ReviewKind } from "./format";
import { AUTO_EXCLUSIONS, CERTAINTIES, HUMAN_EXCLUSIONS, MISS_REASONS, RESULTS, type Certainty, type ReviewResult } from "./reasons";

export type ReportJudgment = { fingerprint: string; revisionId: string | null; result: ReviewResult; reason: string | null; certainty: Certainty | null };

/**
 * 報告に渡す明細 1 件。receiptKey はレセプトを数える鍵（ファイルとファイルの中のレセプトの通し番号）。
 * excluded は対象外の理由（対象なら null）。pending は対象外でないもののうち、まだ人が決めていないこと（unmatched＝当てられず請求を選んでいない／unconfirmed＝当て方を確かめていない）。
 * judgments は判定の全部（古い順）
 */
export type ReportItem = { kind: ReviewKind; receiptKey: string; excluded: string | null; pending: "unmatched" | "unconfirmed" | null; jiyu: string[]; points: number | null; judgments: ReportJudgment[] };

/** 件数：明細の件数と、レセプトの件数 */
export type Count = { items: number; receipts: number };
const countOf = (items: ReportItem[]): Count => ({ items: items.length, receipts: new Set(items.map((i) => i.receiptKey)).size });

export type ReviewRun = {
  fingerprint: string;
  /** 記録を見る前（取り込んだとき）に固定した指紋か。偽なら、取り込んだ後にコードが変わってからの回 */
  fixedAtImport: boolean;
  /** その回の判定で点検に使った版 */
  revisions: string[];
  judged: Count;
  unjudged: Count;
  /** 同じ論点で指摘していた（確定・条件つき・患者情報に分けて） */
  same: Record<Certainty, Count>;
  other: Count;
  none: Count;
  /** 指摘しなかった理由（別の論点・指摘なしの分） */
  reasons: { reason: string; count: Count }[];
};

export type ReviewReport = {
  total: Count;
  byKind: { kind: ReviewKind; count: Count }[];
  /** 対象外（分母から外したもの）。理由ごと */
  excluded: { reason: string; count: Count }[];
  /** まだ人が決めていないもの */
  pending: { unmatched: Count; unconfirmed: Count };
  /** 対象（当て方を確かめた、対象外でない明細） */
  target: Count;
  /** 事由ごと（対象の明細。1 件に記号が 2 つあれば両方に数える） */
  byJiyu: { jiyu: string; count: Count }[];
  /** 減点の点数の合計（対象の増減点連絡書の明細のうち、減点の分。社内の報告にだけ並べる） */
  deductedPoints: number;
  runs: ReviewRun[];
};

export function reportOf(items: ReportItem[], fixedFingerprints: string[]): ReviewReport {
  const excludedOrder = [...AUTO_EXCLUSIONS, ...HUMAN_EXCLUSIONS] as readonly string[];
  const excludedReasons = [...new Set(items.flatMap((i) => (i.excluded ? [i.excluded] : [])))].sort((a, b) => excludedOrder.indexOf(a) - excludedOrder.indexOf(b));
  const target = items.filter((i) => i.excluded === null && i.pending === null);
  const jiyus = [...new Set(target.flatMap((i) => i.jiyu))].sort();
  const fingerprints = [...new Set([...fixedFingerprints, ...target.flatMap((i) => i.judgments.map((j) => j.fingerprint))])];
  const runs = fingerprints.map((fp): ReviewRun => {
    const latest = target.map((i) => ({ i, j: i.judgments.filter((j) => j.fingerprint === fp).at(-1) ?? null }));
    const judged = latest.filter((x) => x.j !== null) as { i: ReportItem; j: ReportJudgment }[];
    const by = (result: ReviewResult) => judged.filter((x) => x.j.result === result);
    const missed = judged.filter((x) => x.j.result !== RESULTS[0]);
    return {
      fingerprint: fp,
      fixedAtImport: fixedFingerprints.includes(fp),
      revisions: [...new Set(judged.flatMap((x) => (x.j.revisionId ? [x.j.revisionId] : [])))].sort(),
      judged: countOf(judged.map((x) => x.i)),
      unjudged: countOf(latest.filter((x) => x.j === null).map((x) => x.i)),
      same: Object.fromEntries(CERTAINTIES.map((c) => [c, countOf(by(RESULTS[0]).filter((x) => x.j.certainty === c).map((x) => x.i))])) as Record<Certainty, Count>,
      other: countOf(by(RESULTS[1]).map((x) => x.i)),
      none: countOf(by(RESULTS[2]).map((x) => x.i)),
      reasons: MISS_REASONS.map((reason) => ({ reason, count: countOf(missed.filter((x) => x.j.reason === reason).map((x) => x.i)) })).filter((r) => r.count.items > 0),
    };
  });
  return {
    total: countOf(items),
    byKind: (["zogen", "henrei"] as const).map((kind) => ({ kind, count: countOf(items.filter((i) => i.kind === kind)) })).filter((k) => k.count.items > 0),
    excluded: excludedReasons.map((reason) => ({ reason, count: countOf(items.filter((i) => i.excluded === reason)) })),
    pending: { unmatched: countOf(items.filter((i) => i.excluded === null && i.pending === "unmatched")), unconfirmed: countOf(items.filter((i) => i.excluded === null && i.pending === "unconfirmed")) },
    target: countOf(target),
    byJiyu: jiyus.map((jiyu) => ({ jiyu, count: countOf(target.filter((i) => i.jiyu.includes(jiyu))) })),
    deductedPoints: target.filter((i) => i.kind === "zogen" && i.points !== null && i.points < 0).reduce((s, i) => s - (i.points ?? 0), 0),
    runs,
  };
}
