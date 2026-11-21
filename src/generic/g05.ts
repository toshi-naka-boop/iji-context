// G05 背反（design.md §12-3）：背反関連テーブルの 4 表（[点] p16・p28。masters.db では tani で分ける）に載っている組が、その表の単位の中に両方あるかを見る。
//   1 日につき（tani 1）… 同じ算定日に両方あれば、言い切りの候補
//   同一月内（tani 2）… 同じレセプトに両方あれば、言い切りの候補
//   同時（tani 3）… 同じ算定単位（点数・回数の単位）に両方あれば、言い切りの候補。別の単位でも、同じ算定日にあれば条件つき（同時に行ったかはレセプトから決まらない。X-96・C-100）
//   1 週間につき（tani 4）… 7 日以内（算定日の差が 6 日以内）に両方あれば、条件つき。起算日から 7 日か暦の週かは項目ごとに違い、データにないので、言い切らない
// 特例条件が 1 の行（[点] p28。条件の中身はデータにない）は、どの表でも条件つき。
// 背反区分（[点] p28 項番6）：1＝コード①を算定する／2＝コード②を算定する／3＝いずれか一方。残す側が決まる組（1・2）は、指摘の値（keep）に入れる。
// 表は組を両向きに持つ（[点] p22・p35）。同じ組は 1 回だけ言う：コードの小さいほうがコード①の行を使い、その向きの行がない組は、ある向きの行を使う
import { commonDays, daysText, noTensuhyo, occurrencesOf, TABLE, tensuhyoOf, unitsOf, type Dated, type Occurrence } from "./tensuhyo";
import { FINDING_LIMIT, type GenericCheck, type GenericFinding } from "./types";

type Row = Dated & { tani: number; code1: string; code2: string; kubun: string; tokurei: string };

/** 7 日以内にある日の組（a の日・b の日。最初の 1 組）。なければ null */
function within7(a: Occurrence, b: Occurrence): [number, number] | null {
  if (!a.timed || !b.timed) return null;
  for (let d = 0; d < 31; d++) {
    if (a.days[d] === 0) continue;
    for (let e = Math.max(0, d - 6); e <= Math.min(30, d + 6); e++) if (b.days[e] > 0) return [d + 1, e + 1];
  }
  return null;
}

export const g05: GenericCheck = {
  id: "G05",
  kind: "背反",
  run(claim, masters, about) {
    const t = tensuhyoOf(masters, about);
    if (t === null) return noTensuhyo(about);
    const occ = occurrencesOf(claim);
    const rowsOf = masters.prepare("SELECT tani, code1, code2, kubun, tokurei, change, created_on, abolished_on FROM haihan WHERE snapshot = ? AND tani = ? AND code1 = ?");
    // 請求に両方ある組の行を、表と組ごとに 1 つ選ぶ
    const pairs = new Map<string, Row>();
    for (const code of occ.keys())
      for (const tani of [1, 2, 3, 4])
        for (const row of rowsOf.all(t.snapshot, tani, code) as Row[]) {
          if (row.code2 === code || !occ.has(row.code2) || !t.live(row)) continue;
          const key = `${tani}:${[row.code1, row.code2].sort().join(":")}`;
          if (!pairs.has(key) || row.code1 < row.code2) pairs.set(key, row);
        }
    const out: GenericFinding[] = [];
    // 上限（FINDING_LIMIT）に達したら、指摘を作らずに数えるだけにする（組で増える。round-32 S-9）
    let more = 0;
    for (const row of pairs.values()) {
      const [a, b] = [occ.get(row.code1)!, occ.get(row.code2)!];
      const cond = row.tokurei !== "0";
      let hit: { key: string; sure: boolean; units: number[]; params: Record<string, string> } | null = null;
      if (row.tani === 2) hit = { key: "month", sure: true, units: unitsOf(a, b), params: {} };
      else if (row.tani === 4) {
        const near = within7(a, b);
        if (near) hit = { key: "week", sure: false, units: unitsOf(a, b), params: { dayA: String(near[0]), dayB: String(near[1]) } };
      } else {
        const days = commonDays(a, b);
        const inB = new Set(b.units);
        const shared = a.units.filter((u) => inB.has(u));
        if (row.tani === 3 && shared.length > 0) hit = { key: "same_unit", sure: true, units: shared, params: {} };
        else if (days.length > 0) hit = { key: row.tani === 1 ? "day" : "same_day", sure: row.tani === 1, units: unitsOf(a, b), params: { days: daysText(days) } };
      }
      if (hit === null) continue;
      if (out.length >= FINDING_LIMIT) {
        more++;
        continue;
      }
      out.push({
        check: "G05",
        kind: "背反",
        certainty: hit.sure && !cond && !t.weak(row) ? "確定" : "条件つき",
        units: hit.units,
        codes: [row.code1, row.code2],
        messageKey: `G05.${hit.key}${cond ? "_cond" : ""}`,
        params: { a: row.code1, b: row.code2, keep: row.kubun === "1" ? row.code1 : row.kubun === "2" ? row.code2 : "いずれか一方", ...hit.params },
        source: { data: TABLE.haihan[row.tani], ref: `診療行為コード①=${row.code1}, 診療行為コード②=${row.code2}` },
      });
    }
    return Object.assign(out, { more });
  },
};
