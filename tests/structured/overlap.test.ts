// 段 19b（design.md §16-3）：重なりの見分け（日＋コード・版の accept・訪問の種類）、たたむ印、「文章にあるがオーダーにない」、当てられない行為の「同じ／違う」。LLM は使わない
import { describe, expect, it } from "vitest";
import type { ActMatch, ChartAct } from "../../src/chart/acts";
import type { StructuredChart } from "../../src/connect/types";
import type { Revision } from "../../src/engine/revisions/types";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { ConfirmedAct } from "../../src/generic/g11";
import { withStructured } from "../../src/structured/g11-input";
import { itemsOf, ORDER_MISSING, overlap, type SItem } from "../../src/structured/overlap";
import { DRUG, put, smallMasters } from "../generic/small-masters";
import { day, YM } from "../helpers/period";

const D = day(5);
const sup = <T,>(items: T[] = []) => ({ status: "supported" as const, items, gaps: {} });
const UNS = { status: "unsupported" as const };
const chart = (p: Partial<StructuredChart> = {}): StructuredChart => ({ visits: UNS, orders: UNS, procedures: UNS, homeCare: UNS, ...p });
const m = (tbl: ActMatch["tbl"], code: string, name = "名"): ActMatch => ({ tbl, code, name, by: "name" });
const act = (category: ChartAct["category"], match: ActMatch | null, extra: Partial<ChartAct> = {}): ChartAct => ({ category, written: "書かれた名前", lookup: [], quote: "書かれた名前", match, ...extra });
const item = (x: Partial<SItem> & Pick<SItem, "kind" | "ref">): SItem => ({ part: x.kind === "drug" ? "orders" : x.kind === "visit" ? "visits" : "procedures", date: D, code: null, tbl: null, name: "電子カルテの表示名", ...x });
/** 皮内、皮下及び筋肉内注射（EM §2-8 の症例のコード 130000510）の区分に、中心静脈注射（同 130004410）を accept として持つ作り物の版（区分の同じコードの見分けだけを確かめる） */
const INJ = "130000510";
const INJ2 = "130004410";
const REV: Revision = { ...r2026, codes: { ...r2026.codes, X_INJ: { primary: INJ, accept: [INJ2] } } };
const ca = (a: ChartAct, i = 0): ConfirmedAct => ({ date: D, noteId: 1, index: i, act: a });

describe("両方にある：構造化データを正にしてたたむ", () => {
  it("文章の投薬とオーダーの薬が同じ日・同じコードでたたまれ、量はオーダーの数（足さない）", () => {
    const items = [item({ kind: "drug", ref: "o1/0", code: DRUG, tbl: "iyakuhin", quantity: "28錠" })];
    const parts = chart({ orders: sup([{}]) as never });
    const ov = overlap([{ date: D, key: "a", act: act("投薬", m("iyakuhin", DRUG), { quantity: "14錠" }) }], items, parts, REV);
    expect(ov.acts.get("a")).toEqual({ status: "folded", refs: ["o1/0"], by: "rule", quantity: "28錠" });
    expect(ov.structuredOnly).toEqual([]);
    const g = withStructured([ca(act("投薬", m("iyakuhin", DRUG), { quantity: "14錠" }))], { chart: parts, items }, REV);
    expect(g.acts.map((a) => [a.act.quantity, a.source ?? "文章"])).toEqual([["28錠", "文章"]]);
    expect(g.scope).toEqual(["オーダーにもある行為をたたみました：1 件"]);
  });
  it("文章の注射が、版の accept で同じ区分の実施の行為とたたまれる（医薬品・器材は同じコードだけ）", () => {
    const items = [item({ kind: "proc", ref: "p1", code: INJ, tbl: "shinryo", quantity: "1回" })];
    const ov = overlap([{ date: D, key: "a", act: act("注射", m("shinryo", INJ2)) }], items, chart({ procedures: sup([{}]) as never }), REV);
    expect(ov.acts.get("a")).toMatchObject({ status: "folded", refs: ["p1"] });
    // 別の日の同じコードは、たたまない
    const other = overlap([{ date: day(6), key: "a", act: act("注射", m("shinryo", INJ2)) }], items, chart({ procedures: sup([{}]) as never }), REV);
    expect(other.acts.get("a")).toEqual({ status: "textOnly", note: ORDER_MISSING });
  });
  it("訪問は種類で見る：訪問診療料の行為は、その日の訪問診療の記録にたたみ、回数は記録の数", () => {
    const items = [item({ kind: "visit", ref: "v1", visitKind: "訪問診療" }), item({ kind: "visit", ref: "v2", visitKind: "往診" })];
    const ov = overlap([{ date: D, key: "a", act: act("診療行為", m("shinryo", r2026.codes.C001_1I.primary)) }], items, chart({ visits: sup([{}]) as never }), REV);
    expect(ov.acts.get("a")).toEqual({ status: "folded", refs: ["v1"], by: "rule", quantity: "1回" });
  });
});

describe("文章にだけある・構造化データにだけある・突き合わせない", () => {
  it("文章にだけある注射は、注射・処置を受け取っている月（0 件を含む）は添え書きつき、unsupported の月は添え書きなしの候補", () => {
    const a = ca(act("注射", m("shinryo", INJ)));
    const on = withStructured([a], { chart: chart({ procedures: sup() }), items: [] }, REV);
    expect(on.acts).toEqual([{ ...a, note: ORDER_MISSING }]);
    const off = withStructured([a], { chart: chart({ procedures: UNS }), items: [] }, REV);
    expect(off.acts).toEqual([a]);
  });
  it("検査は突き合わせない（同じ日・同じコードの実施があっても、文章の行為はそのまま。実施の行為は構造化データから候補にする）", () => {
    const code = "160031710";
    const items = [item({ kind: "proc", ref: "p1", code, tbl: "shinryo" })];
    const ov = overlap([{ date: D, key: "a", act: act("検査", m("shinryo", code)) }], items, chart({ procedures: sup([{}]) as never }), REV);
    expect(ov.acts.get("a")).toEqual({ status: "notCompared" });
    expect(ov.structuredOnly.map((x) => x.ref)).toEqual(["p1"]);
  });
  it("構造化データにだけある行為は source: structured の候補になり、実施で使った材料はその実施の子になる。コードの当たらない行は理由ごとに数える", () => {
    const items = [item({ kind: "proc", ref: "p1", code: INJ, tbl: "shinryo", name: "注射の表示名" }), item({ kind: "material", ref: "p1/0", code: "700080000", tbl: "tokutei", name: "器材の表示名" }), item({ kind: "drug", ref: "o1/0", out: "対応表にないコード" })];
    const g = withStructured([], { chart: chart({ procedures: sup([{}]) as never, orders: sup([{}]) as never }), items }, REV);
    expect(g.acts).toEqual([
      { date: D, source: "structured", ref: "p1", act: { category: "処置", written: "注射の表示名", lookup: [], quote: "注射の表示名", match: { tbl: "shinryo", code: INJ, name: "注射の表示名", by: "name" }, with: [{ kind: "器材", written: "器材の表示名", lookup: [], quote: "器材の表示名", match: { tbl: "tokutei", code: "700080000", name: "器材の表示名", by: "name" } }] } },
    ]);
    expect(g.scope).toEqual(["電子カルテの行為のうち、対応表にないコードは判定の外にしました：1 件"]);
  });
});

describe("当てられない文章の行為（「同じ／違う／選ばない」）", () => {
  const items = [item({ kind: "proc", ref: "p1", code: INJ, tbl: "shinryo", name: "皮下注射" })];
  const parts = chart({ procedures: sup([{}]) as never });
  it("その日の同じ種類の構造化データの行為を横に並べる。初期値は出さず、選ばなければ当てられないまま", () => {
    const ov = overlap([{ date: D, key: "a", act: act("注射", null) }], items, parts, REV);
    expect(ov.acts.get("a")).toEqual({ status: "unmatched", pairs: items });
    const g = withStructured([ca(act("注射", null))], { chart: parts, items }, REV);
    expect(g.acts[0].act.match).toBeNull();
  });
  it("「同じ」を選ぶとたたまれ、構造化データの行為のコードで見る（当てられない数から外れる）。「違う」は残り、構造化データの行為は別の候補", () => {
    const same = withStructured([ca(act("注射", null, { fold: { kind: "order", ref: "p1", by: "person" } }))], { chart: parts, items }, REV);
    expect(same.acts).toHaveLength(1);
    expect(same.acts[0].act.match).toEqual({ tbl: "shinryo", code: INJ, name: "皮下注射", by: "candidate" });
    const diff = withStructured([ca(act("注射", null, { fold: { kind: "order", by: "person", same: false } }))], { chart: parts, items }, REV);
    expect(diff.acts.map((a) => [a.act.match ?? null, a.source ?? "文章"])).toEqual([
      [null, "文章"],
      [{ tbl: "shinryo", code: INJ, name: "皮下注射", by: "name" }, "structured"],
    ]);
  });
});

describe("構造化データの行（itemsOf）", () => {
  it("処方のオーダーの薬・実施の行為と材料・訪問を、入力欄の種類で当てたコードつきの行為にする", () => {
    const d = smallMasters();
    put(d, "iyakuhin", "20261001", { code: "620008991", name: "ゲーベンクリーム１％", yj: "2633705N1031" });
    const s = chart({
      visits: sup([{ ref: "v1", date: D, start: null, end: null, kind: "往診" }]),
      orders: sup([{ ref: "o1", date: D, place: "院内", refills: null, drugs: [{ code: { system: "yj", value: "2633705N1031" }, name: null, days: 7, quantity: "20g" }] }]),
      procedures: sup([{ ref: "p1", date: D, act: { code: { system: "local", value: "X9" }, name: "処置" }, count: 2, items: [{ kind: "器材", code: { system: "rece", value: "700080000" }, name: null, quantity: 1, unit: "個" }] }]),
    });
    const items = itemsOf(s, { db: d, yearMonth: YM, connectorId: "fixture", localMap: () => null });
    expect(items.map((x) => [x.kind, x.ref, x.code, x.quantity ?? null, x.out ?? null])).toEqual([
      ["visit", "v1", null, null, null],
      ["drug", "o1/0", "620008991", "20g", null],
      ["proc", "p1", null, "2回", "対応表にないコード"],
      ["material", "p1/0", "700080000", "1個", null],
    ]);
  });
});
