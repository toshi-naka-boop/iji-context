// 段 18c の完了条件のうち、取り込んだ請求の経路（path: "uke"）の G11 を、作り物の小さな表で確かめるもの（design.md §15-8・§15-10 の 18c の行）。データは同梱しない（§12-7）。
// 元の請求は症例 K8 の文脈（在支診・東京都）を元に、行と事実をテストごとに書く（round-53 C-272：事実の値をテストごとに明記する）。
// 手順 3 は R18 と担当のルールを 1 回（src/generic/g11-rules.ts の rulesStep3）。手順 1 の同じ族の例外は r18SameFamily
import { afterAll, describe, expect, it } from "vitest";
import type { ChartAct } from "../../src/chart/acts";
import { evaluate } from "../../src/engine";
import { g11Owned, g11Owners } from "../../src/engine/derive";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext, ClaimLine, Facts, Finding } from "../../src/engine/types";
import type { DeclarationView, Tri } from "../../src/facility/declaration";
import { evaluateG11, type ConfirmedAct, type G11About, type G11Finding, type G11Result } from "../../src/generic/g11";
import { r18SameFamily, rulesStep3 } from "../../src/generic/g11-rules";
import { claimOfLines } from "../../src/generic/overlap";
import { loadCase } from "../engine/helpers";
import { YM } from "../helpers/period";
import { GEN } from "./small-masters";
import { tensuhyoMasters } from "./small-tensuhyo";

const SNAP = "20261001";
const rev = resolveRevision(YM);
const K = { visit: "C001_1I", oushin: "C000", kanriRO: "C002_2RO1", kanriNI: "C002_2NI1", mitori: "C001_N7_MITORI", shibou: "C001_N8_SHIBOU", dx: "C001_N13_DX", hokatsu: "C002_N10_HOKATSU" } as const;
const code = (k: string) => rev.codes[k].primary;
const name = (k: string) => rev.points[k].name;
const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

function db18c() {
  const db = tensuhyoMasters(SNAP);
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
  return db;
}
let noteId = 0;
const act = (d: number, kubun: string): ConfirmedAct => {
  const a: ChartAct = { category: "診療行為", written: name(kubun), lookup: [], quote: name(kubun), match: { tbl: "shinryo", code: code(kubun), name: name(kubun), by: "name" } };
  return { date: date(d), noteId: ++noteId, act: a };
};
const line = (kubun: string, ...days: number[]): ClaimLine => ({ kubun, count: days.length, dates: days.map(date) });
const held: DeclarationView = { held: () => ({ v: "held" }), nameOf: () => null };
const viewWith = (tri: (kijun: string) => Tri): DeclarationView => ({ held: (c) => tri(c), nameOf: () => null });
const day = (...ds: number[]) => Object.fromEntries(ds.map((d) => [date(d), true]));
const dayFalse = (...ds: number[]) => Object.fromEntries(ds.map((d) => [date(d), false]));

/** 元の請求の文脈：K8 の事実・施設に、行と事実を書き足す。取り込んだ請求なので出来事は持たず、recordsKnown は偽 */
function baseOf(lines: ClaimLine[], facts: Partial<Facts> = {}, facility: Partial<ClaimContext["facility"]> = {}): ClaimContext {
  const k8 = loadCase("K8");
  return {
    ...k8,
    lines,
    events: [],
    recordsKnown: false,
    facts: {
      ...k8.facts,
      table7: { known: true, value: false },
      acuteExacerbation: { known: true, value: false },
      sameDaySeparate: { known: true, value: {} },
      sameDayOushinAfterVisit: { known: true, value: {} },
      contactDocProvided: { known: true, value: true },
      ...facts,
    },
    facility: { ...k8.facility, ...facility },
  };
}
const ok = (r: G11Result) => {
  if ("skip" in r) throw new Error(r.skip);
  return r;
};
/** 取り込んだ請求の G11（手順 3 は担当のルール。元の請求の手書きのルールの結果を hand に渡す） */
function run(base: ClaimContext, acts: ConfirmedAct[], more: { declaration?: DeclarationView; hand?: Finding[]; db?: ReturnType<typeof db18c> } = {}) {
  const db = more.db ?? db18c();
  const about: G11About = { yearMonth: YM, generation: GEN, acts, rxDays: [], path: "uke", dispensing: "outside", declaration: more.declaration ?? held, outpatient: true };
  const claim = claimOfLines(base.lines, rev).claim;
  const opt = { step3: rulesStep3(base, rev, db), sameFamily: r18SameFamily(base, rev, db), hand: more.hand ?? evaluate(base).findings };
  const a = ok(evaluateG11(claim, db, about, rev, opt));
  // 並べ方を逆にしても同じ
  const b = ok(evaluateG11(claim, db, { ...about, acts: [...acts].reverse() }, rev, opt));
  expect(b.findings).toEqual(a.findings);
  expect(b.hidden).toEqual(a.hidden);
  for (const [k, n] of Object.entries(a.counts.caution)) caution[k] = (caution[k] ?? 0) + (n ?? 0);
  for (const f of a.findings) for (const d of f.days) for (const x of d.notes) if (x.rule) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
  return a;
}
/** 段の報告：この段の例で注意つきで出した数（理由ごと。添え書きのある日を 1 つでも持つコードの数）と、手書きのルールの添え書き（ルールごと。日の行の数） */
const caution: Record<string, number> = {};
const byRule: Record<string, number> = {};
afterAll(() => console.log(`段 18c の報告：注意つきの理由ごとの数 ${JSON.stringify(caution)}・手書きのルールの添え書き（ルールごと）${JSON.stringify(byRule)}`));
const keys = (fs: G11Finding[]) => fs.map((f) => `${f.messageKey} ${f.codes.join("+")} ${f.days.map((d) => Number(d.date.slice(8))).join(",")}${f.caution ? " 注意つき" : ""}`);
const notesOn = (f: G11Finding, d: number) => f.days.find((x) => x.date === date(d))!.notes.map((n) => n.text);
const R10 = "往診と訪問診療の同じ日・翌日（R10）に当たる恐れがあります。算定できるか確かめてください";
const R13 = "週の訪問診療の回数（R13）に当たる恐れがあります。算定できるか確かめてください";

describe("担当のルールの表（g11Owners）", () => {
  it("g11Owned の区分を全部覆い、ほかの区分を持たない", () => {
    const owners = g11Owners(rev.consts).flatMap((o) => o.kubun);
    expect([...new Set(owners)].sort()).toEqual([...new Set(g11Owned(rev.consts))].sort());
  });
});

describe("取り込んだ請求で g11Owned の区分も見る（L-97。docs H-2）", () => {
  it("訪問診療料を 2 回のうち 1 回外した UKE に、2 回の訪問のカルテを貼ると、外した日の訪問診療料が missing で出て、R01 の区分誤りに取り忘れを先に確かめる文が返る（R01 の指摘は消えない）", () => {
    const base = baseOf([line(K.visit, 14), line(K.kanriRO, 28)]);
    const hand = evaluate(base).findings;
    expect(hand.map((f) => f.messageKey)).toContain("R01.use_once");
    const r = run(base, [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)], { hand });
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 28`]);
    expect(r.handNotes).toEqual([{ messageKey: "R01.use_once", text: "カルテでは訪問診療が 2 回あります。訪問診療料の取り忘れ（G11）を先に確かめてください" }]);
  });

  it("R03 が包括的支援加算の取り忘れを言う請求では、G11 は同じ月の包括的支援加算を言わない", () => {
    const base = baseOf([line(K.visit, 14, 28), line(K.kanriRO, 28)]);
    const hand: Finding[] = [{ ruleId: "R03", kind: "取り忘れ", lineRefs: [K.kanriRO], messageKey: "R03.missing", reference: "" }];
    const r = run(base, [act(14, K.visit), act(28, K.visit), act(28, K.hokatsu)], { hand });
    expect(r.findings.filter((f) => f.codes.includes(code(K.hokatsu)))).toEqual([]);
    expect(r.scope).toContain("手書きのルールが同じ取り忘れを言っているもの：1 件");
  });
});

describe("往診と同じ日の訪問診療料（R10。2026-11-22 の単純化：隠さず添え書き）", () => {
  it("往診料あり・訪問診療料なしの日の訪問診療料は、sameDaySeparate 偽で「同じ日に往診料があります」の添え書きつきの注意つき", () => {
    const base = baseOf([line(K.oushin, 14), line(K.visit, 28)], { sameDaySeparate: { known: true, value: dayFalse(14) } });
    const r = run(base, [act(14, K.oushin), act(14, K.visit), act(28, K.visit)]);
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 14 注意つき`]);
    expect(notesOn(r.findings[0], 14)).toEqual([`同じ日に往診料があります。${R10}`]);
  });

  it("同じ日の往診料と訪問診療料が両方抜けた：same_encounter では 2 つとも、候補の側から相手を名指しする（C-284）", () => {
    const base = baseOf([line(K.visit, 28)], { sameDaySeparate: { known: true, value: dayFalse(14) } });
    const r = run(base, [act(14, K.oushin), act(14, K.visit), act(28, K.visit)]);
    const oushin = r.findings.find((f) => f.codes.includes(code(K.oushin)))!;
    const visit = r.findings.find((f) => f.codes.includes(code(K.visit)))!;
    expect(notesOn(oushin, 14)).toEqual([`同じ日に${name(K.visit)}の候補があります。${R10}`]);
    expect(notesOn(visit, 14)).toEqual([`同じ日に往診料の候補があります。${R10}`]);
  });

  it("sameDaySeparate 真・sameDayOushinAfterVisit 真・contactDocProvided 偽（same_day_as_visit）なら、訪問診療料だけに添え書き、往診料は添え書きなし", () => {
    const base = baseOf([line(K.visit, 28)], { sameDaySeparate: { known: true, value: day(14) }, sameDayOushinAfterVisit: { known: true, value: day(14) }, contactDocProvided: { known: true, value: false } });
    const r = run(base, [act(14, K.oushin), act(14, K.visit), act(28, K.visit)]);
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.oushin)} 14`, `G11.missing ${code(K.visit)} 14 注意つき`]);
    expect(notesOn(r.findings[1], 14)).toEqual([`同じ日に往診料の候補があります。${R10}`]);
  });

  it("別の日の候補（X-149）：在支診以外で、9 日の往診料のあとの 10 日の訪問診療料の行にだけ添え書き、20 日には付かない（C-281）", () => {
    const base = baseOf([line(K.oushin, 9)], {}, { zaishishin: false, grade: { known: true, value: "3" } });
    const r = run(base, [act(10, K.visit), act(20, K.visit)]);
    const visit = r.findings.find((f) => f.codes.includes(code(K.visit)))!;
    expect(visit.days.map((d) => d.date)).toEqual([date(10), date(20)]);
    expect(notesOn(visit, 10)).toEqual([`前の日に往診料があります。${R10}`]);
    expect(notesOn(visit, 20)).toEqual([]);
    expect(visit.caution).toBe(true);
  });
});

describe("週 3 回（R13）と日の days（C-260・X-137・C-272）", () => {
  // 2026 年 10 月：4 日（日）〜10 日（土）が 1 つの週
  it("元の請求の第 1 週に R13 が出ている UKE で、第 3 週の 20 日の候補は添え書きなし、第 1 週に足す候補は週 3 回の添え書きつき", () => {
    const base = baseOf([line(K.visit, 5, 6, 7, 8)]);
    expect(evaluate(base).findings.map((f) => f.messageKey)).toContain("R13.over_three_a_week");
    const r = run(base, [act(9, K.visit), act(20, K.visit)]);
    const visit = r.findings[0];
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 9,20 注意つき`]);
    // 作り物の電子点数表の回数の表に週 3 回の行（特例条件あり）があるので、回数の表の条件つきの添え書きも付く（隠れない。C-280）
    expect(notesOn(visit, 9)).toContain(`この週の訪問診療料が 3 回を超えます。${R13}`);
    expect(notesOn(visit, 20)).toEqual([]);
  });

  it("別の週の候補：第 1 週が 3 回の UKE に、第 1 週の 4 回目（c1）と第 3 週（c3）の候補。1 件に 2 日が並び、c1 にだけ添え書き（隠さない）", () => {
    const base = baseOf([line(K.visit, 5, 6, 7)]);
    const r = run(base, [act(8, K.visit), act(20, K.visit)]);
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 8,20 注意つき`]);
    expect(notesOn(r.findings[0], 8)).toContain(`この週の訪問診療料が 3 回を超えます。${R13}`);
    expect(notesOn(r.findings[0], 20)).toEqual([]);
    // 第 1 週が 3 回のまま 4 回目と 5 回目（8 日・9 日）が候補なら、2 つとも添え書き
    const two = run(base, [act(8, K.visit), act(9, K.visit), act(20, K.visit)]);
    expect([8, 9, 20].map((d) => notesOn(two.findings[0], d).some((t) => t.includes("（R13）")))).toEqual([true, true, false]);
  });

  it("事実が分からないとき：table7・acuteExacerbation を空にすると、R13 の情報不足が上限を超えた週の日を持ち、その週の候補にだけ情報不足の添え書き", () => {
    const base = baseOf([line(K.visit, 5, 6, 7)], { table7: { known: false }, acuteExacerbation: { known: false } });
    const r = run(base, [act(8, K.visit), act(20, K.visit)]);
    const n8 = notesOn(r.findings[0], 8);
    expect(n8.filter((t) => /を確かめないと算定できるかは言えません$/.test(t))).toHaveLength(1);
    expect(n8.some((t) => t.includes("元の請求に出ています"))).toBe(false);
    expect(notesOn(r.findings[0], 20)).toEqual([]);
  });
});

describe("日を持つ・持たない情報不足（R10。C-272・C-282）", () => {
  it("在支診で 9 日の往診料があり、9 日と 20 日の訪問診療料が抜けた：9 日の sameDaySeparate を空にすると、9 日の行にだけ情報不足の添え書き", () => {
    const base = baseOf([line(K.oushin, 9)], { sameDaySeparate: { known: true, value: {} }, sameDayOushinAfterVisit: { known: true, value: dayFalse(9) } });
    const r = run(base, [act(9, K.visit), act(20, K.visit)]);
    const visit = r.findings.find((f) => f.codes.includes(code(K.visit)))!;
    expect(notesOn(visit, 9)).toHaveLength(1);
    expect(notesOn(visit, 9)[0]).toMatch(/を確かめないと算定できるかは言えません$/);
    expect(notesOn(visit, 20)).toEqual([]);
  });

  it("日を持たない情報不足：contactDocProvided を空にすると、10 日・20 日のどちらの行にも付けず、点検の範囲に 1 行だけ出し、注意つきに数えない", () => {
    const base = baseOf([line(K.oushin, 9)], { contactDocProvided: { known: false } });
    const r = run(base, [act(10, K.visit), act(20, K.visit)]);
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 10,20`]);
    expect(r.scope.filter((s) => s.includes("の候補は算定できるか確かめてください"))).toEqual([`連絡担当者・往診担当医などの文書を患者に提供しているかが分からないので、${name(K.visit)}の候補は算定できるか確かめてください`]);
    expect(r.scope.some((s) => s.startsWith("注意つきで出したもの"))).toBe(false);
  });
});

describe("訪問診療料と管理料が全部抜けた（X-143）・看取り（R09）", () => {
  it("UKE に訪問診療料が 1 回もなく、カルテに 2 回の訪問と在医総管：どれも missing で、管理料に添え書きは付かない", () => {
    const r = run(baseOf([]), [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)]);
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.visit)} 14,28`, `G11.missing ${code(K.kanriRO)} 28`]);
    // UKE に訪問診療料が 1 回ある月でも同じ
    const one = run(baseOf([line(K.visit, 14)]), [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)]);
    expect(keys(one.findings)).toEqual([`G11.missing ${code(K.visit)} 28`, `G11.missing ${code(K.kanriRO)} 28`]);
  });

  it("看取り加算と死亡診断加算が両方抜けて R09 が当たるときは、関わる候補に R09 の添え書きが付いて注意つきで出る（隠さない）", () => {
    const r = run(baseOf([line(K.visit, 14, 28), line(K.kanriRO, 28)]), [act(14, K.visit), act(28, K.visit), act(28, K.mitori), act(28, K.shibou)]);
    for (const k of [K.mitori, K.shibou]) {
      const f = r.findings.find((x) => x.codes.includes(code(k)))!;
      expect([k, f.caution, notesOn(f, 28).some((t) => t.includes("（R09）に当たる恐れがあります"))]).toEqual([k, true, true]);
    }
    expect(r.hidden.filter((h) => h.reason === "担当のルール")).toEqual([]);
  });
});

describe("施設基準の扱い（L-128）と同じ族の区分誤り（C-250・C-263）", () => {
  const oneN = { grade: { known: true as const, value: "1N" as const }, kyokagata: true };
  it("1N と申告した施設で、在支診の側の在医総管（施設基準 3168）を選ぶと、G10 の届出なしでも隠れず、R18 の同じ族の添え書きで出て、kubunDoubts に入る。表にないコード（721）も結び付けば隠れる", () => {
    const db = db18c();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '3168' WHERE snapshot = ? AND code = ?").run(SNAP, code(K.kanriRO));
    const decl = viewWith((k) => (k === "3168" ? { v: "not", reason: "grade_lacks" } : { v: "held" }));
    const base = baseOf([line(K.visit, 14, 28)], {}, oneN);
    const r = run(base, [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)], { db, declaration: decl });
    expect(keys(r.findings)).toEqual([`G11.missing ${code(K.kanriRO)} 28 注意つき`]);
    expect(notesOn(r.findings[0], 28)).toEqual([`正しい区分は${name("C002_1N_RO1")}の恐れがあります（R18 による）。どの区分で算定するか確かめてください`]);
    expect(r.kubunDoubts).toEqual([{ written: name(K.kanriRO), tbl: "shinryo", code: code(K.kanriRO) }]);
    expect(r.hidden).toEqual([]);
    db.prepare("UPDATE shinryo SET shisetsu_g2 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, code(K.kanriRO));
    const decl2 = viewWith((k) => (k === "3168" || k === "721" ? { v: "not", reason: "notified_no" } : { v: "held" }));
    const hid = run(base, [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)], { db, declaration: decl2 });
    expect(keys(hid.findings)).toEqual([]);
    expect(hid.hidden.map((h) => h.reason)).toEqual(["施設基準"]);
  });

  it("DX の届出なし（4100）：在宅医療DX情報活用加算の候補は手順 1 の G10（R12 に譲る前の結果）で隠れ、言わなかった一覧に施設基準で並ぶ", () => {
    const db = db18c();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '4100' WHERE snapshot = ? AND code = ?").run(SNAP, code(K.dx));
    const decl = viewWith((k) => (k === "4100" ? { v: "not", reason: "notified_no" } : { v: "held" }));
    const r = run(baseOf([line(K.visit, 14, 28), line(K.kanriRO, 28)]), [act(14, K.visit), act(28, K.visit), act(14, K.dx)], { db, declaration: decl });
    expect(keys(r.findings)).toEqual([]);
    expect(r.hidden.map((h) => `${h.written} ${h.reason}`)).toEqual([`${name(K.dx)} 施設基準`]);
  });

  it("回数の区分では消さない（C-263）：月 1 回の患者で月 2 回以上の区分の対応が当たり、R01 の同じ族の添え書きが付いても kubunDoubts に入らない", () => {
    const r = run(baseOf([line(K.visit, 14)]), [act(14, K.visit), act(14, K.kanriRO)]);
    expect(notesOn(r.findings[0], 14)).toEqual([`正しい区分は${name(K.kanriNI)}の恐れがあります（R01 による）。どの区分で算定するか確かめてください`]);
    expect(r.kubunDoubts).toEqual([]);
  });

  it("R18 の情報不足（C-252）：種別の申告がないと、在医総管の候補に「施設の種別…を確かめないと」が添えられ、言わなかったものに数えない", () => {
    const r = run(baseOf([line(K.visit, 14, 28)], {}, { grade: { known: false }, zaishishin: null }), [act(14, K.visit), act(28, K.visit), act(28, K.kanriRO)]);
    const kanri = r.findings.find((f) => f.codes.includes(code(K.kanriRO)))!;
    expect(notesOn(kanri, 28).some((t) => /を確かめないと算定できるかは言えません$/.test(t))).toBe(true);
    expect(r.hidden).toEqual([]);
  });
});

describe("約束の 3 つ目（手書きのルールの側）", () => {
  it("この段のどの例でも、手順 3 の請求で候補が関わる担当のルール・R18 の指摘があれば、その候補に添え書きがある（日を持たない R10 の情報不足を除く）", () => {
    const cases: [ClaimContext, ConfirmedAct[]][] = [
      [baseOf([line(K.oushin, 14), line(K.visit, 28)], { sameDaySeparate: { known: true, value: dayFalse(14) } }), [act(14, K.visit), act(28, K.visit)]],
      [baseOf([line(K.visit, 5, 6, 7)]), [act(8, K.visit), act(20, K.visit)]],
      [baseOf([line(K.visit, 14)]), [act(14, K.visit), act(14, K.kanriRO)]],
    ];
    for (const [base, acts] of cases) {
      const r = run(base, acts);
      // 候補を全部足した請求に担当のルールを掛け、関わる候補（区分と日）に添え書きがあるか
      const all: ClaimContext = { ...base, lines: [...base.lines, ...r.findings.flatMap((f) => f.days.map((d) => ({ kubun: Object.keys(rev.codes).find((k) => rev.codes[k].primary === f.codes[0])!, count: 1, dates: [d.date] })))] };
      for (const f of evaluate(all).findings.filter((x) => ["R01", "R10", "R13", "R18"].includes(x.ruleId) && !(x.kind === "情報不足" && !x.days && !x.missing?.date)))
        for (const g of r.findings)
          for (const d of g.days) {
            const k = Object.keys(rev.codes).find((x) => rev.codes[x].primary === g.codes[0])!;
            if (f.lineRefs.includes(k) && (!f.days || f.days.includes(d.date))) expect([f.messageKey, g.codes[0], d.date, d.notes.length > 0]).toEqual([f.messageKey, g.codes[0], d.date, true]);
          }
    }
  });
});

describe("管理料の候補の人数と注14 の側（round-61 X-203・X-204）", () => {
  /** 候補 1 つに手順 3 を掛けた添え書き */
  const notesOf = (base: ClaimContext, kubun: string, d: number) => rulesStep3(base, rev, db18c())([{ id: 1, date: date(d), units: [{ items: [{ kind: "SI", code: code(kubun) }], count: 1 }] }]).notes.get(1) ?? [];
  const some = (n14: "通常" | "減算"): Partial<ClaimContext["facility"]> => ({ building: { known: true, value: "some" }, note14: { known: true, value: n14 } });

  it("X-203：building「ある」・人数 50 人以上・通常の申告で、1 人の区分の管理料の候補には、R19 の人数の区分（50 人以上の区分）を名指しする添え書きが付く", () => {
    const base = baseOf([line(K.visit, 14, 28)], { buildingBand: { known: true, value: "50+" } }, some("通常"));
    const notes = notesOf(base, K.kanriRO, 28);
    expect(notes.map((n) => n.rule)).toContain("R19");
    expect(notes.find((n) => n.rule === "R19")!.text).toContain(name("C002_2RO5"));
  });

  it("X-204：減算の申告・人数 10〜19 人で、訪問診療 1 回の月に 10〜19 人の減の行（2ロ）の候補 → R01 の直し先は同じ人数の 2ニ の減の行（通常の行を名指ししない）", () => {
    const base = baseOf([line(K.visit, 14)], { buildingBand: { known: true, value: "10-19" } }, some("減算"));
    const notes = notesOf(base, "C002_2RO3_N14", 14);
    const r01 = notes.find((n) => n.rule === "R01")!;
    expect(r01.text).toContain(name("C002_2NI3_N14"));
    expect(r01.text).not.toContain(`${name("C002_2NI3")}の恐れ`);
  });

  it("X-204：減算の申告・人数 10〜19 人で、通常の行（2ロ）の候補でも、R01 の直し先は減の行（2ニ）", () => {
    const base = baseOf([line(K.visit, 14)], { buildingBand: { known: true, value: "10-19" } }, some("減算"));
    const r01 = notesOf(base, "C002_2RO3", 14).find((n) => n.rule === "R01")!;
    expect(r01.text).toContain(name("C002_2NI3_N14"));
  });
});
