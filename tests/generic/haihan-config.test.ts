// 段 15a：config/haihan-exceptions.json を EM §2-12 に縛る（design.md §13-1・§13-5）。
// id は 1 対 1、分類と kind、組の例外の並び、表の単位、一言の条件が EM と同じ。問いには必ず「その他」「判定不能」（means=決まらない）があり、点数・金額の語がない
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hxRowsOf } from "../../scripts/check-haihan-exceptions";
import { DATED_FACT_KEYS } from "../../src/claim/facts";
import { targetOfNeed } from "../../src/engine";
import type { NeedKey } from "../../src/engine/types";
import { HAIHAN } from "../../src/generic/haihan";

const em = readFileSync(path.join(__dirname, "../../design/iji-context/sources/evidence-master-iji-context.md"), "utf8");
const section = em.slice(em.indexOf("### 2-12. 背反の特例条件の例外"), em.indexOf("## 3. 採用値一覧"));
const cells = (l: string) => l.split("|").slice(1, -1).map((x) => x.trim());
const hxEm = section.split("\n").map(cells).filter((c) => /^HX-\d{2}$/.test(c[0] ?? ""));
const hpEm = section.split("\n").map(cells).filter((c) => /^HP-\d{2}$/.test(c[0] ?? ""));
const KIND = { ア: "receipt", イ: "fact", ウ: "none" } as Record<string, string>;
const TANI = { "1 日": 1, 同月: 2, 同時: 3 } as Record<string, number>;

describe("config/haihan-exceptions.json と EM §2-12", () => {
  it("例外（HX）の id が 1 対 1 で、分類・一言の条件・原文の確かめが合う", () => {
    expect(hxEm.length).toBeGreaterThan(0);
    expect(HAIHAN.exceptions.map((x) => x.id)).toEqual(hxEm.map((c) => c[0]));
    for (const c of hxEm) {
      const x = HAIHAN.exceptions.find((y) => y.id === c[0])!;
      expect([x.id, x.text, x.kind]).toEqual([c[0], c[1], KIND[c[2]]]);
    }
    // 確かめられない例外はウ（X-102）
    for (const r of hxRowsOf(em)) if (!r.status.startsWith("確かめた")) expect([r.id, r.kind]).toEqual([r.id, "ウ"]);
  });

  it("組（HP）の id が 1 対 1 で、表の単位と例外の id の全部が合う。例外はどれも表 1 にある", () => {
    expect(HAIHAN.patterns.map((p) => p.id)).toEqual(hpEm.map((c) => c[0]));
    for (const c of hpEm) {
      const p = HAIHAN.patterns.find((y) => y.id === c[0])!;
      expect([p.id, p.tani, p.exceptions]).toEqual([c[0], [TANI[c[2]]], c[3] === "—" ? [] : c[3].split("・")]);
      for (const id of p.exceptions) expect(HAIHAN.exceptions.some((x) => x.id === id)).toBe(true);
    }
    // どの例外も、どこかの組で使う
    for (const x of HAIHAN.exceptions) expect([x.id, HAIHAN.patterns.some((p) => p.exceptions.includes(x.id))]).toEqual([x.id, true]);
  });

  // receipt で G12 の事実で決める例外（g12。design.md §19-13 の 3）は allow を持たない（v45 で足した形）
  it("kind ごとに要るものがある：receipt は allow（か G12 の事実の g12）、fact は ask、none は ask も allow も持たない", () => {
    for (const x of HAIHAN.exceptions) {
      expect([x.id, x.kind === "receipt" ? (x.allow !== undefined) !== (x.g12 !== undefined) : x.allow === undefined && x.g12 === undefined]).toEqual([x.id, true]);
      expect([x.id, x.kind === "fact" ? x.ask !== undefined : x.ask === undefined]).toEqual([x.id, true]);
    }
  });

  it("全部の問いに「その他」「判定不能」（means=決まらない）があり、問いと選択肢に点数・金額の語がない", () => {
    const asks = HAIHAN.exceptions.flatMap((x) => (x.ask ? [{ id: x.id, ask: x.ask }] : []));
    expect(asks.length).toBeGreaterThan(0);
    for (const { id, ask } of asks) {
      for (const label of ["その他", "判定不能"]) expect([id, ask.choices.find((c) => c.label === label)?.means]).toEqual([id, "決まらない"]);
      for (const t of [ask.question, ...ask.choices.map((c) => c.label)]) expect([id, t, /点数|金額|点|円/.test(t)]).toEqual([id, t, false]);
      expect(new Set(ask.choices.map((c) => c.label)).size).toBe(ask.choices.length);
      // key は haihan:<HX-nn> か、既存の事実（意味が同じもの）。既存の事実は、日ごとの事実で、医療事務あてで、問いも日ごとのものに限る
      // （答えを書く関数が、共有の事実を答えの選択肢から真偽で書くため。医師あての事実を事務の答えで書かない。round-36 C-140）
      expect([id, ask.factKey === `haihan:${id}` || ((DATED_FACT_KEYS as readonly string[]).includes(ask.factKey) && targetOfNeed(ask.factKey as NeedKey) === "clerk" && ask.scope === "day")]).toEqual([id, true]);
    }
  });
});
