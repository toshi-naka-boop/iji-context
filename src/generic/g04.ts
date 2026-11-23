// G04 包括（design.md §12-3）：補助マスターで、親の診療行為の包括のグループと単位を引き、包括・被包括テーブルで、そのグループに含まれる診療行為（子）が、単位の中に別に算定されているかを見る。
// 包括の単位（[点] p25 項番4。全部）と、その扱い：
//   01 1 日につき（付表2 p33「同一日に含まれるもの」）… 親と子が同じ算定日に両方あれば、言い切りの候補
//   02 同一月内 … 親と子が同じレセプトに両方あれば、言い切りの候補
//   03 同時 … 同時に行ったかは、レセプトから決まらない。同じ算定日に両方あれば、条件つき
//   06 1 手術につき … 同じ手術かは、レセプトから決まらない。同じ算定日に両方あれば、条件つき
//   05 手術前 1 週間 … 手引きに、いつから数える 1 週間かの定めがない（手術の日はレセプトから決まらない）ので、点検しない
//   00 関連なし … 親ではない
// 特例条件が 1 の行（[点] p27。条件の中身はデータにない）は、どの単位でも条件つき。
// 包括・被包括テーブルは、親の注加算も子として持つ（同時の単位に多い）。親と子が同じ算定単位にあっても、同じ見方で出す。
// 読むのは包括単位①・グループ番号①だけ（②③は錨がないので読まない。EM §2-11）。指摘は親子の組ごとに 1 件（同じ子の指摘を 1 つにまとめるのは画面）
import { commonDays, daysText, noTensuhyo, occurrencesOf, TABLE, tensuhyoOf, unitsOf, type Dated } from "./tensuhyo";
import { FINDING_LIMIT, type GenericCheck, type GenericFound } from "./types";

type Parent = Dated & { code: string; unit1: string; group1: string };
type Child = Dated & { group_no: string; tokurei: string };

/** 包括の単位 → 指摘の種類。day は「同じ算定日に両方」、month は「同じレセプトに両方」で見る。sure は、特例条件がなければ言い切りの候補 */
const UNITS: Record<string, { key: string; by: "day" | "month"; sure: boolean }> = {
  "1": { key: "day", by: "day", sure: true },
  "2": { key: "month", by: "month", sure: true },
  "3": { key: "same", by: "day", sure: false },
  "6": { key: "surgery", by: "day", sure: false },
};

export const g04: GenericCheck = {
  id: "G04",
  kind: "包括",
  run(claim, masters, about) {
    const t = tensuhyoOf(masters, about);
    if (t === null) return noTensuhyo(about);
    const occ = occurrencesOf(claim);
    const parentOf = masters.prepare("SELECT code, unit1, group1, change, created_on, abolished_on FROM hojo WHERE snapshot = ? AND code = ?");
    const groupsOf = masters.prepare("SELECT group_no, tokurei, change, created_on, abolished_on FROM houkatsu WHERE snapshot = ? AND code = ?");
    // 請求にある親を、グループ番号ごとに
    const parents = new Map<string, Parent[]>();
    for (const code of occ.keys()) {
      const p = parentOf.get(t.snapshot, code) as Parent | undefined;
      if (!p || !t.live(p) || !Object.hasOwn(UNITS, p.unit1)) continue;
      parents.set(p.group1, [...(parents.get(p.group1) ?? []), p]);
    }
    const out: GenericFound = [];
    if (parents.size === 0) return out;
    // 上限（FINDING_LIMIT）に達したら、指摘を作らずに数えるだけにする（親 × 子で増える。round-32 S-9）
    let more = 0;
    // 算定日の印（1〜31 日をビットで。算定日を持たないコードは 0＝同じ日はない）。数えるだけの組でも、日の配列を作らずに同じ日の有無を見る
    const masks = new Map([...occ].map(([c, o]) => [c, o.timed ? o.days.reduce((m, n, d) => (n > 0 ? m | (1 << d) : m), 0) : 0]));
    for (const [code, child] of occ) {
      for (const row of groupsOf.all(t.snapshot, code) as Child[]) {
        if (!t.live(row)) continue;
        for (const p of parents.get(row.group_no) ?? []) {
          if (p.code === code) continue;
          const unit = UNITS[p.unit1];
          if (unit.by === "day" && (masks.get(p.code)! & masks.get(code)!) === 0) continue;
          if (out.length >= (about.findingLimit ?? FINDING_LIMIT)) {
            more++;
            continue;
          }
          const parent = occ.get(p.code)!;
          const days = unit.by === "day" ? commonDays(parent, child) : [];
          const cond = row.tokurei !== "0";
          out.push({
            check: "G04",
            kind: "包括",
            certainty: unit.sure && !cond && !t.weak(p) && !t.weak(row) ? "確定" : "条件つき",
            units: unitsOf(parent, child),
            // 親、子の順（画面は、同じ子の指摘を 1 つにまとめる）
            codes: [p.code, code],
            messageKey: `G04.${unit.key}${cond ? "_cond" : ""}`,
            params: { parent: p.code, child: code, ...(unit.by === "day" ? { days: daysText(days) } : {}) },
            source: { data: TABLE.houkatsu, ref: `グループ番号=${row.group_no}, 診療行為コード=${code}／${TABLE.hojo} 診療行為コード=${p.code}, 包括単位①=${p.unit1}` },
          });
        }
      }
    }
    return Object.assign(out, { more });
  },
};
