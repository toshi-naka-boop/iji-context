// 略した書き方の合成カルテ（E-3。fixtures/charts/K8〜K11-abbrev.json。design.md §15-10 の 6・段 18a）：
// 本人が確かめたあとの形の acts（lookup つき）を持たせ、LLM を通さずに、各行為の正しいコードが候補の 20 件に入り、選んだあと当てたコードが合成カルテのコードと同じになることを確かめる。
// 手で作った小さな表と、データがあるとき（RESEMEN_MASTER_DIR）は本物の masters.db で
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tableKeyOfAct, tableKeyOfChild, validateActs, type ActMatch, type TableKey } from "../../src/chart/acts";
import { noteText } from "../../src/chart/extract";
import { matchItem, rowIn, rowsFor } from "../../src/chart/match";
import { rxDefault } from "../../src/chart/rx-default";
import { openMasters, type MastersDb } from "../../src/masters/db";
import { ABBREV_CASES, abbrevOf, chartMasters, type AbbrevEntry } from "./small-chart-masters";

type Item = { k: string; date: string; key: TableKey; written: string; lookup: string[]; match: ActMatch };
const itemsOf = (k: string, e: AbbrevEntry): Item[] =>
  e.acts.flatMap((a) => [
    { k, date: e.date, key: tableKeyOfAct(a.category), written: a.written, lookup: a.lookup, match: a.match! },
    ...(a.with ?? []).map((c) => ({ k, date: e.date, key: tableKeyOfChild(c.kind), written: c.written, lookup: c.lookup, match: c.match! })),
  ]);
const all = ABBREV_CASES.flatMap((k) => abbrevOf(k).entries.flatMap((e) => itemsOf(k, e)));

/** 各行為の正しいコードの順位（候補の何番目か。当てた初期値なら 0。入らなければ -1） */
function ranks(db: MastersDb) {
  return all.map((it) => {
    const m = matchItem(rowsFor(db, it.key, "2026-10"), it.key, it.written, it.lookup, null);
    const i = m.candidates.findIndex((c) => c.tbl === it.match.tbl && c.code === it.match.code);
    return { it, byName: m.initial?.by === "name" && m.initial.code === it.match.code, rank: i, wrongInitial: m.initial !== null && m.initial.code !== it.match.code };
  });
}

/** wrongInitial：名前の完全一致が 1 つで、合成カルテと違うコードに当たる行為（本人が選び直す。EM §5-1-2 の注にある書き方だけ） */
function check(db: MastersDb, wrongInitial: string[] = []) {
  const r = ranks(db);
  expect(r.filter((x) => x.wrongInitial).map((x) => `${x.it.k} ${x.it.written}`)).toEqual(wrongInitial);
  // 正しいコードが候補の 20 件に入る
  expect(r.filter((x) => x.rank < 0).map((x) => `${x.it.k} ${x.it.date} ${x.it.written} → ${x.it.match.code}`)).toEqual([]);
  // 合成カルテの acts を選んだあとの形として保存の検査に通すと、捨てられるものがなく、当てたコードは全部その 1 枚の表に実在する
  for (const k of ABBREV_CASES) {
    for (const e of abbrevOf(k).entries) {
      const v = validateActs({ acts: e.acts, rx: e.rxNotes }, noteText(e), true);
      expect([k, e.date, v.dropped]).toEqual([k, e.date, []]);
      for (const it of itemsOf(k, e)) expect([it.written, rowIn(rowsFor(db, it.key, "2026-10"), it.match.tbl, it.match.code)?.code]).toEqual([it.written, it.match.code]);
    }
  }
  return r;
}

describe("略した書き方の合成カルテ（E-3）", () => {
  it("4 症例・8 日。書き方は E-3 の表の範囲で、院内・院外の初期値は処方の文から決まり、K11 の院内の日は院内、院外の日は院外処方箋", () => {
    expect(ABBREV_CASES.map((k) => abbrevOf(k).entries.map((e) => e.date))).toEqual(ABBREV_CASES.map(() => ["2026-10-14", "2026-10-28"]));
    const k11 = abbrevOf("K11").entries;
    expect(k11.map((e) => [rxDefault(e.rxNotes), e.rxChoice])).toEqual([["inside", "inside"], ["outside", "outside"]]);
    // K8 X31 のゲーベンクリーム 20g は with の量に残る
    const burn = abbrevOf("K8").entries[0].acts.find((a) => a.written === "熱傷処置")!;
    expect(burn.with).toEqual([expect.objectContaining({ written: "ゲーベンクリーム１％", quantity: "20g", match: expect.objectContaining({ code: "620008991" }) })]);
  });
  it("手で作った表で、各行為の正しいコードが候補の 20 件に入り、選んだあとのコードが合成カルテのコードと同じ", () => {
    check(chartMasters());
  });
  const real = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
  it.skipIf(!real || !existsSync(real))("本物の masters.db で、各行為の正しいコードが候補の 20 件に入る（上位 5 件の数も出す）", () => {
    const db = openMasters(real)!;
    try {
      // 「爪甲除去」は処置の J001-7 爪甲除去の名称と完全に一致する（EM §5-1-2 の X36 の注）。名前で当てた初期値は処置の側で、本人が手術の 150054110 を選び直す
      const r = check(db, ["K8 爪甲除去"]);
      const top5 = r.filter((x) => x.byName || (x.rank >= 0 && x.rank < 5)).length;
      console.info(`略した書き方の合成カルテ：行為 ${r.length}、名前で当たった ${r.filter((x) => x.byName).length}、名前で別のコードに当たった ${r.filter((x) => x.wrongInitial).length}、候補の 20 件に入った ${r.filter((x) => x.rank >= 0).length}、上位 5 件 ${top5}`);
    } finally {
      db.close();
    }
  });
});
