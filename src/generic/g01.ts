// G01 コード（design.md §12-1「版と履歴」・§12-3）：診療行為・医薬品・特定器材のコードが、持っているマスターにあるか。
// 言い切りには上げない：持っている 1 枚のあいだの更新を全部持っているとは確かめられない（X-99）。変更年月日は、使い始めの日として使わない（C-98）。
// 出すのは 2 つ：持っているどの 1 枚にもないコード／診療年月の前後どちらかの 1 枚にしかないコード
import { nameOf, pickSnapshot, snapshotsOf, type MastersDb } from "../masters/db";
import type { GenericCheck, GenericFinding } from "./types";

const MASTER = { SI: "shinryo", IY: "iyakuhin", TO: "tokutei" } as const;
/** 行の種類の呼び名（指摘の文に入れる） */
const WHAT = { SI: "診療行為", IY: "医薬品", TO: "特定器材" } as const;

/**
 * コード 1 つを、持っている 1 枚と突き合わせる。null は「言うことがない」。
 * 見るのは、診療年月に使う世代の、診療年月の末日以前でいちばん新しい 1 枚（前）と、末日より後でいちばん古い 1 枚（後）。
 * 前後の両方を持っていて片方にしかなければ、その側を言う。片方しか持っていなければ、その 1 枚にあれば言わない。
 * 前後のどちらにもなく、ほかの 1 枚（もっと前・もっと後・別の世代）にだけあるコードは、ある側（診療年月の前にあれば「前」）を言う
 */
function judge(db: MastersDb, table: (typeof MASTER)[keyof typeof MASTER], code: string, yearMonth: string, generation: string): { key: "not_in_any" | "only_before" | "only_after"; name: string | null } | null {
  const end = `${yearMonth.replace("-", "")}31`;
  const has = snapshotsOf(db, table).filter((s) => nameOf(db, table, s, code) !== null);
  if (has.length === 0) return { key: "not_in_any", name: null };
  const mine = snapshotsOf(db, table, generation);
  const before = mine.filter((s) => s <= end).at(-1);
  const after = mine.find((s) => s > end);
  const inBefore = before !== undefined && has.includes(before);
  const inAfter = after !== undefined && has.includes(after);
  const earlier = has.filter((s) => s <= end).at(-1);
  const name = nameOf(db, table, earlier ?? has[0], code);
  if (inBefore && inAfter) return null;
  if (inBefore) return after === undefined ? null : { key: "only_before", name };
  if (inAfter) return before === undefined ? null : { key: "only_after", name };
  return { key: earlier !== undefined ? "only_before" : "only_after", name };
}

export const g01: GenericCheck = {
  id: "G01",
  kind: "コード",
  run(claim, masters, about) {
    // コードごとに 1 件（当たる単位をまとめる）。同じ数字のコードでも、行の種類が違えば別のマスターで見る
    const seen = new Map<string, { kind: keyof typeof MASTER; code: string; units: number[] }>();
    claim.units.forEach((u, i) => {
      for (const it of u.items) {
        const key = `${it.kind}:${it.code}`;
        const hit = seen.get(key) ?? { kind: it.kind, code: it.code, units: [] };
        if (!hit.units.includes(i)) hit.units.push(i);
        seen.set(key, hit);
      }
    });
    // 診療年月の世代の 1 枚がないマスターがあれば、動かさない（近い世代で代用しない）
    for (const kind of new Set([...seen.values()].map((x) => x.kind)))
      if (pickSnapshot(masters, MASTER[kind], about.yearMonth, about.generation) === null) return { skip: `診療年月の世代（${about.generation}）の${WHAT[kind]}のマスターがありません` };
    const out: GenericFinding[] = [];
    for (const { kind, code, units } of seen.values()) {
      const r = judge(masters, MASTER[kind], code, about.yearMonth, about.generation);
      if (r === null) continue;
      out.push({
        check: "G01",
        kind: "コード",
        certainty: "条件つき",
        units,
        codes: [code],
        messageKey: `G01.${r.key}`,
        params: { code, what: WHAT[kind], ...(r.name !== null ? { name: r.name } : {}) },
        source: { data: MASTER[kind], ref: `code=${code}` },
      });
    }
    return out;
  },
};
