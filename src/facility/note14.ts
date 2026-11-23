// 注14 の申告（note14）と計算の道具の結果を比べる純関数（design.md §15-2「確かめ直す日の知らせ」。round-57 C-320・round-58 C-331・round-59 C-342・round-60 C-350。L-132・L-160）。
// 道具は申告を書き換えない（L-132）。ここは、点数の高い側（通常）が申告だけで続く向きを止めるかどうかと、画面に添える文を決めるだけ。
// 道具の結果の表（note14_worksheets。マイグレーション 16）は段 17i で足す。それまでは結果がないので、どの入口も止まらない（17i の結果を渡すテストは段 17i で通す）

/** 道具の結果の 1 行（確認月 "YYYY-MM"・結果・同じ確認月の中の追記の順） */
export type Note14Result = { checkMonth: string; outcome: "meets" | "not_meets" | "undecided"; seq: number };
/** 申告 note14 の選んだ値（normal＝通常の点数・reduced＝減算の点数・unknown＝分からない） */
export type Note14Choice = "normal" | "reduced" | "unknown";

/** 通常で残す理由（警告の画面で必ず 1 つ選ぶ。自由記述の欄は置かない。L-160） */
export const NOTE14_OVERRIDE_REASONS = { kouseikyoku: "厚生局に確かめた", input_wrong: "道具の入力が違っていた", other: "その他" } as const;
export type Note14OverrideReason = keyof typeof NOTE14_OVERRIDE_REASONS;

/**
 * 比べる結果と、止めるか（round-60 C-350）：今日以前の確認月のうち、道具の結果のある最も新しい確認月の結果と比べる。どの確認月の結果もなければ none。
 * block：その確認月に not_meets（減算になる）が 1 つでもあり、そのあとに meets で上書きされておらず、申告が 通常（点数の高い側が申告だけで続く向きだけを止める。L-126・L-130）。
 * undecided を追記しても止めは外れない（C-342 の (c)）。differs：結果と申告が違う（meets と 減算、または not_meets で止めの外れた 減算 以外）が、止めない。
 * results は同じ確認月の中では seq の順に並べて読む
 */
export function note14Compare(results: Note14Result[], choice: Note14Choice | null, today: string): { month: string | null; state: "none" | "same" | "differs" | "block"; results: Note14Result[] } {
  const thisMonth = today.slice(0, 7);
  const months = [...new Set(results.map((r) => r.checkMonth).filter((m) => m <= thisMonth))].sort();
  const month = months.at(-1) ?? null;
  if (month === null) return { month: null, state: "none", results: [] };
  const mine = results.filter((r) => r.checkMonth === month).sort((a, b) => a.seq - b.seq);
  const lastNot = mine.map((r) => r.outcome).lastIndexOf("not_meets");
  const reduces = lastNot >= 0 && !mine.slice(lastNot + 1).some((r) => r.outcome === "meets");
  if (reduces && choice === "normal") return { month, state: "block", results: mine };
  const last = mine.at(-1)!.outcome;
  const differs = (reduces && choice !== "reduced") || (!reduces && last === "meets" && choice === "reduced");
  return { month, state: differs ? "differs" : "same", results: mine };
}

/** 警告・事務長の画面の文（L-160。round-60 C-350） */
export const NOTE14_TEXT = {
  differs: "道具の結果と今の申告が違います",
  overrideWarning: (month: string) => `道具の結果（${month}：減算になる）と違う申告を残します`,
  overrideManager: (month: string) => `注14：道具の結果と違う申告で残しています（${month}）`,
  needInput: "注14 を入れてください（10 人以上の区分の管理料の行がある請求があります）",
} as const;

/** 確かめ直す日の既定（design.md §15-2 の 6。v31）：確かめた日の次の確認月（版の定数。EM R8-201）の末日 */
export function nextCheckMonthEnd(checkedOn: string, checkMonths: readonly number[]): string {
  const y = Number(checkedOn.slice(0, 4));
  const m = Number(checkedOn.slice(5, 7));
  const sorted = [...checkMonths].sort((a, b) => a - b);
  const next = sorted.find((x) => x > m);
  const [ny, nm] = next === undefined ? [y + 1, sorted[0]] : [y, next];
  const end = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(end).padStart(2, "0")}`;
}
