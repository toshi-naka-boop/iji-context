// 注14 の計算の道具の 1 段目：取り込んだ UKE の SI の行から、月ごとに回数を数える（design.md §15-13。L-134・L-150）。
// 数えるのは、その月の診療年月の版の「回数の門に数える訪問診療の行」の別表（rev.consts.note14.countRows。EM §2-8 の「数えるためだけの行」）にあるコードだけ。
// 版の区分からも区分番号の鍵からも探さない（同じ鍵に並ぶ加算の行を数えないため。W-4）。別表のない月は自動で数えない。
// 同じ月のレセプトの鍵（氏名・生年月日・性別・診療年月・レセプト種別）が 2 つ以上のレセプトで重なる月は自動で数えない（どちらが正しいかは人が決める）。
// 鍵はメモリの中だけで作り、戻り値・記録・ログに出さない（数だけを返す）
import type { UkeClaim, UkePatient } from "../uke/types";

/** 期間の中で同じ患者を 1 人と数える同定の鍵（氏名〔空白を除く〕・生年月日・性別）。L-146 */
export const identityKey = (p: Pick<UkePatient, "name" | "birth" | "sex">): string => [p.name.replace(/\s/g, ""), p.birth, p.sex].join("|");
/** 同じ月のレセプトの重なりを見る鍵（同定の鍵＋診療年月＋レセプト種別）。取り込みの一覧（段 17g。src/server/app/uke.ts）もこれを使う（round-61 C-374） */
export const sameMonthKey = (p: Pick<UkePatient, "name" | "birth" | "sex" | "receiptType">, yearMonth: string): string => [identityKey(p), yearMonth, p.receiptType].join("|");

/** months のうち、同じ月のレセプトの鍵が 2 つ以上のレセプトで重なる月（1 段目と 2 段目の下書きが使う 1 つの判定。C-374） */
export function overlapMonths(receipts: { yearMonth: string; patient: Pick<UkePatient, "name" | "birth" | "sex" | "receiptType"> }[], months: string[]): string[] {
  return months.filter((m) => {
    const keys = receipts.filter((r) => r.yearMonth === m).map((r) => sameMonthKey(r.patient, m));
    return new Set(keys).size !== keys.length;
  });
}

/**
 * 月ごとの自動の数の状態：ok＝数えた／none＝取り込みがない／no_table＝その月の版に別表がない／overlap＝同じ月のレセプトが重なる／
 * unreadable＝読めない請求（未対応のレセプト・行が 1 つも読めていないレセプト）がある（0 回と数えない。round-61 X-201。unreadable はその枚数）
 */
export type AutoMonth =
  | { month: string; state: "ok"; receipts: number; kou: number; otsuExtra: number }
  | { month: string; state: "unreadable"; receipts: number; unreadable: number }
  | { month: string; state: "none" | "no_table" | "overlap"; receipts: number };

export const AUTO_TEXT = {
  none: "この月の取り込みがありません。回数を入れてください",
  no_table: "この月の版には数える行の表がないので、自動では数えません。回数を入れてください",
  overlap: "同じ月のレセプトが重なっています。どちらが正しいかを決めてから数えます。回数を入れてください",
  unreadable: "この月には読めない請求があるので、自動では数えません。取り込み直すか、回数を入れてください",
} as const;

/** 読めない請求か（未対応のレセプト〔UkeClaim.unsupported〕か、行が 1 つも読めていないレセプト）。0 回の請求と混同しない（round-61 X-201） */
export const unreadableClaim = (c: Pick<UkeClaim, "unsupported" | "units">): boolean => c.unsupported !== undefined || c.units.length === 0;

/** 単位の回数（算定日ごとの回数の合計。日の欄がなければ回数の欄） */
const timesOf = (u: UkeClaim["units"][number]) => {
  const d = u.days.reduce((a, x) => a + x, 0);
  return d > 0 ? d : u.count;
};

/**
 * 月ごとに数える（純関数）。claims は取り込みの一覧にある全部のレセプト（形式だけを読んだもの）。
 * rowsOf はその月の版の別表（なければ null）
 */
export function countMonths(claims: Pick<UkeClaim, "yearMonth" | "patient" | "units" | "unsupported">[], months: string[], rowsOf: (month: string) => { code: string; reading: "both" | "otsu" }[] | null): AutoMonth[] {
  return months.map((month) => {
    const mine = claims.filter((c) => c.yearMonth === month);
    const receipts = mine.length;
    const rows = rowsOf(month);
    if (!rows) return { month, state: "no_table", receipts };
    if (receipts === 0) return { month, state: "none", receipts };
    const unreadable = mine.filter(unreadableClaim).length;
    if (unreadable > 0) return { month, state: "unreadable", receipts, unreadable };
    if (overlapMonths(mine, [month]).length > 0) return { month, state: "overlap", receipts };
    const reading = new Map(rows.map((r) => [r.code, r.reading]));
    let kou = 0;
    let otsuExtra = 0;
    for (const c of mine)
      for (const u of c.units)
        for (const it of u.items) {
          if (it.kind !== "SI") continue;
          const r = reading.get(it.code);
          if (r === "both") kou += timesOf(u);
          else if (r === "otsu") otsuExtra += timesOf(u);
        }
    return { month, state: "ok", receipts, kou, otsuExtra };
  });
}
