// G06 算定回数（design.md §12-3）：算定回数テーブル（[点] p18〜19・p24・p30）の、算定単位ごとの上限回数を、レセプトの回数が超えていないかを見る。
// 算定単位コード（[点] 付表1 p32。算定回数テーブルに出てくるもの全部）と、その扱い：
//   121 日 … 算定日ごとの回数の合計が上限を超える日があれば、言い切りの候補
//   131 月 … レセプトの回数の合計が上限を超えていれば、言い切りの候補
//   138 週 … 起算日から 7 日か暦の週かは項目ごとに違い、データにない（起算日はレセプトから分からない）。次の両方を満たすとき（＝どちらの数え方でも超える）だけ、条件つき：
//            暦の週（日曜〜土曜）の合計が上限を超える／連続する 7 日のどこかに、上限の 2 倍を超える回数がある（理由は run の中）。月をまたぐ週は、この月の分だけで数える
//   言わない（レセプト 1 枚から数えられない）：142 2 週／143 2 月／144 3 月／145 4 月／146 6 月／147 12 月／148 5 年／161 2 年／162 年度（過去の月が要る）、
//     141 一連／132 入院初日／133 入院中／134 退院時／135 初回／159 初診時／53 患者当り／56 手術当り／149 妊娠中／150 検査当り／151 1 疾患当り／160 1 分娩当り（区切りがレセプトにない）、
//     10 個／28 単位／107 臓器／109 部位／110 肢／111 局所／112 種目／117 歯／119 側／122 椎間／123 筋／126 箇所／140 神経（数える対象が回数ではない）
// 特例条件が 1 の行（[点] p30。条件の中身はデータにない）は、条件つき。
// 回数の数え方は手引きに定めがないので、少なく数える側：単位の回数（算定日ごとの回数）を、そのコードのある単位について足す。同じ単位に同じコードが 2 行あっても 1 回分。きざみの数量データは数えない。
// 医科診療行為マスターの上限回数（項番36）は、単位が仕様に書かれていない（EM §2-11）。レセプトの回数の合計が超えていれば、条件つき（月の上限で同じことを言ったコードには言わない）
import { pickSnapshot, shinryoOf } from "../masters/db";
import { daysText, noTensuhyo, occurrencesOf, TABLE, tensuhyoOf, type Dated } from "./tensuhyo";
import type { GenericCheck, GenericFinding } from "./types";

type Row = Dated & { unit_code: number; limit_count: number; tokurei: string };
const [DAY, MONTH, WEEK] = [121, 131, 138];

export const g06: GenericCheck = {
  id: "G06",
  kind: "回数",
  run(claim, masters, about) {
    const t = tensuhyoOf(masters, about);
    if (t === null) return noTensuhyo(about);
    const si = pickSnapshot(masters, "shinryo", about.yearMonth, about.generation);
    if (si === null) return { skip: `診療年月の世代（${about.generation}）の診療行為のマスターがありません` };
    const rowsOf = masters.prepare("SELECT unit_code, limit_count, tokurei, change, created_on, abolished_on FROM kaisu WHERE snapshot = ? AND code = ?");
    /** 月の 1 日の曜日（0＝日曜） */
    const firstDow = new Date(`${about.yearMonth}-01T00:00:00Z`).getUTCDay();
    const out: GenericFinding[] = [];
    for (const [code, o] of occurrencesOf(claim)) {
      const push = (key: string, sure: boolean, row: Row | null, limit: number, params: Record<string, string>) =>
        out.push({
          check: "G06",
          kind: "回数",
          certainty: sure && row !== null && row.tokurei === "0" && !t.weak(row) ? "確定" : "条件つき",
          units: o.units,
          codes: [code],
          messageKey: `G06.${key}${row !== null && row.tokurei !== "0" ? "_cond" : ""}`,
          params: { code, limit: String(limit), ...params },
          source: row !== null ? { data: TABLE.kaisu, ref: `診療行為コード=${code}, 算定単位コード=${row.unit_code}` } : { data: TABLE.shinryo, ref: `診療行為コード=${code}, 上限回数` },
        });
      let monthSaid = false;
      for (const row of rowsOf.all(t.snapshot, code) as Row[]) {
        if (!t.live(row) || row.limit_count <= 0) continue;
        if (row.unit_code === MONTH && o.month > row.limit_count) {
          monthSaid = true;
          push("month", true, row, row.limit_count, { count: String(o.month) });
        } else if (row.unit_code === DAY && o.timed) {
          const over = o.days.flatMap((n, d) => (n > row.limit_count ? [d + 1] : []));
          if (over.length > 0) push("day", true, row, row.limit_count, { days: daysText(over), count: String(Math.max(...o.days)) });
        } else if (row.unit_code === WEEK && o.timed) {
          // 連続する 7 日のどこかに、上限の 2 倍を超える回数があるときだけ言う（round-32 codex-2）。起算日（指示日など）はレセプトから分からないが、
          // 起算日から数える 7 日の期間は互いに重ならず、どの連続する 7 日も、多くて 2 つの期間にまたがるだけ。2 倍を超える回数があれば、
          // 区切りが 7 日の中のどこに来ても、片方の期間に上限を超える回数が残る（＝起算日の数え方でも必ず超える）。2 倍以下なら、2 つの期間に分かれて正しい請求であり得る
          const inSeven = o.days.some((_, d) => o.days.slice(d, d + 7).reduce((s, n) => s + n, 0) > 2 * row.limit_count);
          if (!inSeven) continue;
          // 暦の週（日曜〜土曜）ごとの合計
          const weeks = new Map<number, { count: number; days: number[] }>();
          o.days.forEach((n, d) => {
            if (n === 0) return;
            const w = weeks.get(Math.floor((d + firstDow) / 7)) ?? { count: 0, days: [] };
            weeks.set(Math.floor((d + firstDow) / 7), { count: w.count + n, days: [...w.days, d + 1] });
          });
          const over = [...weeks.values()].filter((w) => w.count > row.limit_count);
          if (over.length > 0) push("week", false, row, row.limit_count, { days: over.map((w) => daysText(w.days)).join("／"), count: String(Math.max(...over.map((w) => w.count))) });
        }
      }
      const limit = shinryoOf(masters, si.snapshot, code)?.limit_count ?? 0;
      if (!monthSaid && limit > 0 && o.month > limit) push("master_limit", false, null, limit, { count: String(o.month) });
    }
    return out;
  },
};
