// 段 12：手書きのルールと、データで動く点検の重なり（design.md §12-2。src/generic/overlap.ts）。
// 小さな表（tests/generic/small-tensuhyo.ts）で、同梱の症例に誤りを 1 つ入れた請求を、手書きのルールとデータで動く点検の両方に掛けて、重ねる。実データでの確認は tests/generic/tables-real.test.ts
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext, EngineResult, Finding, Rule } from "../../src/engine/types";
import { evaluateGeneric } from "../../src/generic";
import { claimOfLines, mappedLinesOf, overlap, type MappedLine } from "../../src/generic/overlap";
import type { GenericFinding } from "../../src/generic/types";
import { line, loadCase, withLines } from "../engine/helpers";
import { day, YM } from "../helpers/period";
import { GEN } from "./small-masters";
import { C, tensuhyoMasters } from "./small-tensuhyo";

const about = { yearMonth: YM, generation: GEN };
const K1 = loadCase("K1");
const K5 = loadCase("K5");
const code = (kubun: string) => r2026.codes[kubun].primary;

/** 請求を、手書きのルールとデータで動く点検（G04〜G06）の両方に掛けて、重ねる */
function both(ctx: ClaimContext) {
  const hand = evaluate(ctx);
  const { claim, mapped } = claimOfLines(ctx.lines, r2026);
  const generic = evaluateGeneric(claim, tensuhyoMasters(), about).findings.filter((f) => f.check !== "G01");
  return { hand, generic, ...overlap(hand, r2026, ctx.recordsKnown, mapped, generic) };
}
const keys = (fs: { messageKey: string }[]) => fs.map((f) => f.messageKey);
const handKeys = (r: EngineResult, ruleId: string) => r.findings.filter((f) => f.ruleId === ruleId).map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing!.field}` : f.messageKey));

describe("各ルールの申告（covers）", () => {
  it("R04・R05・R06・R09・R11・R12・R17 が、判定する組を申告している。ほかのルールは申告しない", () => {
    const covers = Object.fromEntries(r2026.rules.flatMap((r) => (r.covers ? [[r.id, r.covers(r2026)]] : [])));
    expect(Object.keys(covers)).toEqual(["R04", "R05", "R06", "R09", "R11", "R12", "R17"]);
    // 段 13：R06 は特定疾患処方管理加算の傷病名（G08 と重ねる）、R17 は必ず要る記載（EM §2-10 表 1 の「算定すれば必ず」の行の区分。G07 と重ねる）
    expect(covers.R06).toEqual({ kind: "傷病名", finding: "excluded_disease", kubun: [["F400_N4"]] });
    expect([covers.R17.kind, covers.R17.finding]).toEqual(["記載もれ", "comment_missing"]);
    expect(covers.R17.kubun.map((k: string[]) => k[0]).sort()).toEqual([...new Set(r2026.comments.filter((c) => c.when === "always").flatMap((c) => c.kubun))].sort());
    expect(covers.R17.kubun).toContainEqual(["C103_2"]);
    expect(covers.R17.kubun).not.toContainEqual(["C000"]);
    expect(covers.R04).toEqual({ kind: "背反", finding: "only_main", kubun: [["C101_2I", "C103_2"]] });
    expect(covers.R09).toEqual({ kind: "背反", finding: "mitori_with_shibou", kubun: [["C001_N7_MITORI", "C001_N8_SHIBOU"]] });
    expect(covers.R11).toEqual({ kind: "回数", finding: "judgement_once_a_month", kubun: [["D026_3"], ["D026_4"], ["D026_5"]] });
    expect(covers.R12).toEqual({ kind: "背反", finding: "same_month", kubun: [["C001_N13_DX", "A_DENSHI_RENKEI"], ["C001_N13_DX2", "A_DENSHI_RENKEI"]] });
    // R05：管理料 6 区分 × 含まれる項目 5 区分
    expect([covers.R05.kind, covers.R05.finding, covers.R05.kubun.length]).toEqual(["包括", "bundled", 30]);
    expect(covers.R05.kubun).toContainEqual(["C002_2I1", "F400_3"]);
    expect(covers.R05.kubun).toContainEqual(["C002-2_2NI1", "F400_N6_1"]);
  });

  it("申告した指摘の種類は、そのルールが実際に出す種類で、出来事を読まない（記録のない請求でも判定している）", () => {
    for (const rule of r2026.rules) {
      const c = rule.covers?.(r2026);
      if (!c) continue;
      expect(rule.recordFindings, rule.id).not.toContain(c.finding);
      for (const set of c.kubun) for (const k of set) expect(rule.kubun, `${rule.id} ${k}`).toContain(k);
    }
  });
});

describe("(1) 重複：手書きが指摘を出した組は、データの側から 2 回言わない", () => {
  it("R05（在医総管の月の処方箋料）と G04 の同一月内の包括", () => {
    const r = both(withLines(K1, line("F400_3", 1, [day(6)])));
    expect(handKeys(r.hand, "R05")).toEqual(["R05.bundled"]);
    expect(r.generic.filter((f) => f.check === "G04").map((f) => f.codes)).toEqual([[C.zaiisoukan, C.shohosen]]);
    expect([keys(r.findings.filter((f) => f.check === "G04")), r.duplicate, r.judged]).toEqual([[], 1, 0]);
  });

  it("R04（指導管理料は主たるもの 1 つ）と G05 の同一月内の背反", () => {
    const r = both(withLines(K1, line("C101_2I", 1, [day(6)])));
    expect(handKeys(r.hand, "R04")).toEqual(["R04.only_main"]);
    expect(keys(r.generic.filter((f) => f.check === "G05"))).toEqual(["G05.month"]);
    expect([keys(r.findings.filter((f) => f.check === "G05")), r.duplicate]).toEqual([[], 1]);
  });

  it("R09（看取り加算と死亡診断加算）と G05、R11（判断料は月 1 回）と G06", () => {
    const mitori = K5.lines.find((l) => l.kubun === "C001_N7_MITORI")!;
    const a = both(withLines(K5, line("C001_N8_SHIBOU", 1, mitori.dates)));
    expect(handKeys(a.hand, "R09")).toContain("R09.mitori_with_shibou");
    expect(a.generic.some((f) => f.messageKey === "G05.month" && f.codes.includes(C.mitori))).toBe(true);
    expect(a.findings.some((f) => f.codes.includes(C.shibou))).toBe(false);
    const b = both(withLines(K1, line("D026_3", 1, [day(20)])));
    expect(handKeys(b.hand, "R11")).toContain("R11.judgement_once_a_month");
    expect(keys(b.generic.filter((f) => f.check === "G06"))).toEqual(["G06.month"]);
    expect([keys(b.findings.filter((f) => f.check === "G06")), b.duplicate]).toEqual([[], 1]);
  });

  it("R12（在宅医療DX情報活用加算と、電子的診療情報連携体制整備加算）と G05", () => {
    const r = both(withLines(K1, line("A_DENSHI_RENKEI", 1, [day(6)])));
    expect(handKeys(r.hand, "R12")).toContain("R12.same_month");
    expect(r.generic.map((f) => [f.messageKey, [...f.codes].sort()])).toContainEqual(["G05.month", [C.denshi, C.dx].sort()]);
    expect(r.findings.some((f) => f.codes.includes(C.denshi))).toBe(false);
  });

  it("同じルールの別の指摘（R11 の「BNP は生化学的検査(Ⅱ)判断料」）は、重複に数えない：判断料の回数の指摘は、そのまま出る", () => {
    // 判断料(Ⅱ) を外して BNP だけにし（R11 は区分誤りを出す）、血液学的検査判断料を 2 回にする細工を、対応を手で作って確かめる
    const mapped: MappedLine[] = [{ kubun: "D008_19", unit: 0, codes: [C.bnp] }, { kubun: "D026_3", unit: 1, codes: [C.handan] }];
    const hand = { findings: [{ ruleId: "R11", kind: "区分誤り", lineRefs: ["D008_19", "D026_3"], messageKey: "R11.bnp_is_biochem2", reference: "" } satisfies Finding], applied: ["R11"] };
    const g: GenericFinding = { check: "G06", kind: "回数", certainty: "条件つき", units: [1], codes: [C.handan], messageKey: "G06.day", params: {}, source: { data: "", ref: "" } };
    // 重複ではない。R11 は動いて情報不足もないので、(3)「判定済み」として止まる
    expect(overlap(hand, r2026, true, mapped, [g])).toEqual({ findings: [], duplicate: 0, judged: 1 });
  });
});

describe("(2) 手書きが「確かめてください」で止まったとき：データの指摘は出す", () => {
  it("届出の区分が不明（R12 は情報不足で止まる）でも、在宅医療DX情報活用加算と電子的診療情報連携体制整備加算の背反が出る（X-95）", () => {
    const ctx = withLines({ ...K1, facility: { ...K1.facility, dxTier: { known: false } } }, line("A_DENSHI_RENKEI", 1, [day(6)]));
    const r = both(ctx);
    expect(handKeys(r.hand, "R12")).toEqual(["情報不足:facility.dxTier"]);
    const shown = r.findings.filter((f) => f.codes.includes(C.denshi));
    expect(shown.map((f) => [f.messageKey, f.certainty, [...f.codes].sort()])).toEqual([["G05.month", "条件つき", [C.denshi, C.dx].sort()]]);
    expect([r.duplicate, r.judged]).toEqual([0, 0]);
  });
});

describe("(3) 手書きが判定して黙ったとき：条件を全部満たす組だけ止め、数を返す", () => {
  /** 作り物の版：1 つのルールが、訪問診療料と往診料の組（背反）を申告する */
  const fake = (over: Partial<Rule> = {}): Revision => {
    const rule: Rule = { id: "RX", kubun: ["C001_1I", "C000"], reference: "", recordFindings: [], soundWhenPartial: [], appliesTo: () => true, needs: () => [], check: () => [], covers: () => ({ kind: "背反", finding: "pair", kubun: [["C000", "C001_1I"]] }), ...over };
    return { ...r2026, rules: [rule] };
  };
  const mapped: MappedLine[] = [{ kubun: "C001_1I", unit: 0, codes: [C.houmon] }, { kubun: "C000", unit: 1, codes: [C.oushin] }];
  const g: GenericFinding = { check: "G05", kind: "背反", certainty: "条件つき", units: [0, 1], codes: [C.oushin, C.houmon], messageKey: "G05.day_cond", params: {}, source: { data: "", ref: "" } };
  const silent = { findings: [] as Finding[], applied: ["RX"] };
  const missing: Finding = { ruleId: "RX", kind: "情報不足", lineRefs: [], missing: { target: "clerk", field: "facility.dxTier" }, messageKey: "RX.missing_fact", reference: "" };

  it("申告があり、ルールが動き、情報不足がなく、当たる単位が全部エンジンに渡っている → 止める（「手書きのルールが判定済み 1 件」）", () => {
    expect(overlap(silent, fake(), false, mapped, [g])).toEqual({ findings: [], duplicate: 0, judged: 1 });
  });

  it("止めない：ルールが動いていない／情報不足を返した／試算の結果（動いたルールが分からない）", () => {
    expect(overlap({ findings: [], applied: [] }, fake(), true, mapped, [g]).findings).toEqual([g]);
    expect(overlap({ findings: [missing], applied: ["RX"] }, fake(), true, mapped, [g]).findings).toEqual([g]);
    expect(overlap({ findings: [] }, fake(), true, mapped, [g]).findings).toEqual([g]);
  });

  it("止めない：当たるコードが、対象外の単位にもある（手書きは、その行を見ていない。C-99）", () => {
    // 往診料が、エンジンに渡った単位 1 のほかに、対象外の単位 2（表にない加算と同じ単位）にもある
    expect(overlap(silent, fake(), true, mapped, [{ ...g, units: [0, 1, 2] }])).toEqual({ findings: [{ ...g, units: [0, 1, 2] }], duplicate: 0, judged: 0 });
    // 当たるコードそのものが、エンジンに渡っていない
    expect(overlap(silent, fake(), true, mapped.slice(0, 1), [g]).findings).toEqual([g]);
  });

  it("止めない：その判定が出来事を読み、カルテ側の記録がない請求。記録があれば止める", () => {
    const reads = fake({ recordFindings: ["pair"] });
    expect(overlap(silent, reads, false, mapped, [g]).findings).toEqual([g]);
    expect(overlap(silent, reads, true, mapped, [g])).toEqual({ findings: [], duplicate: 0, judged: 1 });
  });

  it("止めない：種類が違う（申告は背反、指摘は回数）・組が違う（申告にない組）", () => {
    const count: GenericFinding = { ...g, check: "G06", kind: "回数", codes: [C.houmon], units: [0] };
    expect(overlap(silent, fake(), true, mapped, [count]).findings).toEqual([count]);
    const other = fake({ covers: () => ({ kind: "背反", finding: "pair", kubun: [["C000", "A001"]] }) });
    expect(overlap(silent, other, true, mapped, [g]).findings).toEqual([g]);
  });
});

describe("(4) それ以外は、そのまま出す", () => {
  it("手書きが申告していない組（往診料と訪問診療料。R10）：同じ日にあれば、条件つきの背反がそのまま出る", () => {
    const visit = K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0];
    const r = both(withLines(K1, line("C000", 1, [visit])));
    expect(r.findings.filter((f) => f.check === "G05").map((f) => [f.messageKey, f.certainty, f.codes])).toEqual([["G05.day_cond", "条件つき", [C.oushin, C.houmon]]]);
  });

  it("同梱の症例（正しい請求）と小さな表：言い切りの候補は 1 件も出ない", () => {
    for (const name of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) {
      const ctx = loadCase(name);
      const { claim } = claimOfLines(ctx.lines, r2026);
      const all = evaluateGeneric(claim, tensuhyoMasters(), about, undefined, new Set(["G04.day", "G04.month", "G05.day", "G05.month", "G05.same_unit", "G06.day", "G06.month"])).findings.filter((f) => f.check !== "G01");
      expect(all.filter((f) => f.certainty === "確定"), name).toEqual([]);
    }
  });
});

describe("行とコードの対応", () => {
  it("区分キーの行：区分を primary のコードに直し、1 行を 1 単位にする。算定日は 1〜31 日の回数に。コードに直せない区分（包括の検査）は掛けない", () => {
    const { claim, mapped } = claimOfLines([line("C001_1I", 2, [day(6), day(20)]), line("D007_10", 1, [day(6)]), line("D026_3", 1, [day(6)])], r2026);
    expect(mapped).toEqual([{ kubun: "C001_1I", unit: 0, codes: [code("C001_1I")] }, { kubun: "D026_3", unit: 1, codes: [code("D026_3")] }]);
    expect(claim.units.map((u) => [u.items.map((i) => i.code), u.count, u.days!.flatMap((n, d) => (n > 0 ? [`${d + 1}:${n}`] : []))])).toEqual([[[code("C001_1I")], 2, ["6:1", "20:1"]], [[code("D026_3")], 1, ["6:1"]]]);
  });

  it("きざみで数える区分（行の回数が 項目数 × 回数）は、算定のある日ごとに 1 回として渡す（少なく数える側）", () => {
    const k = Object.keys(r2026.codes).find((x) => r2026.codes[x].quantity)!;
    const { claim } = claimOfLines([line(k, 3, [day(6), day(6), day(6)])], r2026);
    expect([claim.units[0].count, claim.units[0].days![5]]).toEqual([1, 1]);
  });

  it("UKE の行：mapClaim の lines と origins を並べる（accept のコードで書かれた行も、その区分の行）", () => {
    const accept = r2026.codes.F400_3.accept[0];
    const mapped = mappedLinesOf([{ kubun: "C002_2I1" }, { kubun: "F400_3" }], [{ unit: 0, codes: [C.zaiisoukan] }, { unit: 3, codes: [accept] }]);
    expect(mapped).toEqual([{ kubun: "C002_2I1", unit: 0, codes: [C.zaiisoukan] }, { kubun: "F400_3", unit: 3, codes: [accept] }]);
    // accept のコードで書かれた処方箋料：R05 の指摘と同じ組なので、G04 は重複として出さない（区分キーではなく、コードで重ねる。C-99）
    const hand = { findings: [{ ruleId: "R05", kind: "背反", lineRefs: ["F400_3"], messageKey: "R05.bundled", reference: "" } satisfies Finding], applied: ["R05"] };
    const g: GenericFinding = { check: "G04", kind: "包括", certainty: "条件つき", units: [0, 3], codes: [C.zaiisoukan, accept], messageKey: "G04.month", params: {}, source: { data: "", ref: "" } };
    expect(overlap(hand, r2026, false, mapped, [g])).toEqual({ findings: [], duplicate: 1, judged: 0 });
  });

  it("回数 0（算定日なし）の行は、点検に渡さない（round-32 codex-1）：DX 加算と電子的診療情報連携体制整備加算の背反（同一月内）が出ない", () => {
    const r = both(withLines(K1, line("A_DENSHI_RENKEI", 0, [])));
    expect(r.hand.findings.filter((f) => f.ruleId === "R12")).toEqual([]);
    expect(r.generic.filter((f) => f.codes.includes(C.denshi))).toEqual([]);
    // 回数 1 なら、同じ組が出る（落とすのは回数 0 の行だけ）
    const one = both(withLines(K1, line("A_DENSHI_RENKEI", 1, [day(6)])));
    expect(one.generic.some((f) => f.messageKey === "G05.month" && f.codes.includes(C.denshi))).toBe(true);
    const { claim, mapped } = claimOfLines([line("C001_1I", 2, [day(6), day(20)]), line("A_DENSHI_RENKEI", 0, [])], r2026);
    expect([claim.units.length, mapped.map((m) => m.kubun)]).toEqual([1, ["C001_1I"]]);
  });
});
