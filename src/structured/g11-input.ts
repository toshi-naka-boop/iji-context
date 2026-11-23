// 構造化データとの突き合わせ（design.md §16-3）を、G11 の入力（確かめた行為の並び）に掛ける。決まった規則だけで、LLM は使わない。
// 両方にある行為は構造化データを正にし（回数・量は構造化データ）、文章にだけある行為には添え書き、構造化データにだけある行為は構造化データから候補にする
import type { ActMatch, ChartAct } from "../chart/acts";
import type { StructuredChart } from "../connect/types";
import type { Revision } from "../engine/revisions/types";
import type { ConfirmedAct } from "../generic/g11";
import { overlap, type SItem } from "./overlap";

const keyOf = (a: ConfirmedAct, i: number) => `${a.noteId ?? "-"}:${a.index ?? `i${i}`}`;
const matchOf = (x: SItem, by: ActMatch["by"]): ActMatch => ({ tbl: x.tbl!, code: x.code!, name: x.name, by });

/** 構造化データにだけある行為の種類（G11 の振り分けに使う：薬は投薬、材料は器材、ほかは処置） */
const categoryOf = (x: SItem): ChartAct["category"] => (x.kind === "drug" ? "投薬" : x.kind === "material" ? "器材" : x.kind === "procDrug" ? "投薬" : "処置");

/**
 * 行為の並びに突き合わせを掛ける。返すのは G11 に渡す行為の並びと、点検の範囲に足す行（判定の外にした構造化データのコードの数、たたんだ数）
 */
export function withStructured(acts: ConfirmedAct[], s: { chart: StructuredChart; items: SItem[] }, rev: Revision): { acts: ConfirmedAct[]; scope: string[] } {
  const keyed = acts.map((a, i) => ({ a, key: keyOf(a, i) }));
  const ov = overlap(
    keyed.map(({ a, key }) => ({ date: a.date, key, act: a.act })),
    s.items,
    s.chart,
    rev,
  );
  const byRef = new Map(s.items.map((x) => [x.ref, x]));
  let folded = 0;
  const out: ConfirmedAct[] = keyed.map(({ a, key }) => {
    const o = ov.acts.get(key);
    let act: ChartAct = a.act;
    let note: string | undefined;
    if (o?.status === "folded") {
      folded++;
      const first = byRef.get(o.refs[0]);
      // 本人が「同じ」を選んだ当てられない行為は、構造化データの行為のコードで見る
      if (!act.match && first?.code) act = { ...act, match: matchOf(first, "candidate") };
      if (o.quantity) act = { ...act, quantity: o.quantity };
    } else if (o?.status === "textOnly" && o.note) note = o.note;
    if (act.with) {
      act = {
        ...act,
        with: act.with.map((c, j) => {
          const co = ov.children.get(`${key}/${j}`);
          return co?.status === "folded" && co.quantity ? { ...c, quantity: co.quantity } : c;
        }),
      };
    }
    return { ...a, act, ...(note ? { note } : {}) };
  });
  // 構造化データにだけある行為：実施で使った薬・材料は、その実施（親）の子にする（親も構造化データにだけあるとき）
  const only = ov.structuredOnly;
  const parents = new Map<string, ConfirmedAct>();
  for (const x of only.filter((y) => y.kind === "proc" || y.kind === "drug")) {
    const c: ConfirmedAct = { date: x.date, source: "structured", ref: x.ref, act: { category: categoryOf(x), written: x.name, lookup: [], quote: x.name, ...(x.quantity ? { quantity: x.quantity } : {}), match: matchOf(x, "name") } };
    parents.set(x.ref, c);
    out.push(c);
  }
  for (const x of only.filter((y) => y.kind === "procDrug" || y.kind === "material")) {
    const parent = parents.get(x.ref.split("/")[0]);
    const child = { kind: x.kind === "material" ? ("器材" as const) : ("薬" as const), written: x.name, lookup: [], quote: x.name, ...(x.quantity ? { quantity: x.quantity } : {}), match: matchOf(x, "name") };
    if (parent && parent.act.category !== "投薬") parent.act = { ...parent.act, with: [...(parent.act.with ?? []), child] };
    else out.push({ date: x.date, source: "structured", ref: x.ref, act: { category: categoryOf(x), written: x.name, lookup: [], quote: x.name, ...(x.quantity ? { quantity: x.quantity } : {}), match: matchOf(x, "name") } });
  }
  const scope = [
    ...(folded > 0 ? [`オーダーにもある行為をたたみました：${folded} 件`] : []),
    ...Object.entries(ov.out).map(([reason, n]) => `電子カルテの行為のうち、${reason}は判定の外にしました：${n} 件`),
  ];
  return { acts: out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)), scope };
}
