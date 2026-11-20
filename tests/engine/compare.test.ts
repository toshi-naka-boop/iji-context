// 改定の比較と、版を選ぶ試算（design.md §11-2・§11-12。§11-8 の完了条件 5・6、§11-12 の完了条件 (c)(d)）。
// 値は evidence-master（EM）§2-9 と突き合わせる。請求の判定（evaluate・resolveRevision）が変わっていないことも、ここで縛る
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateWith } from "../../src/engine";
import { compareRevisions, type CompareResult } from "../../src/engine/compare";
import { deriveLines, manualLinesOf, type DeriveInput } from "../../src/engine/derive";
import { expectedKanri } from "../../src/engine/predicates";
import { assertCompareRevisions, COMPARE_REVISIONS, hasRevision, resolveRevision, REVISIONS, revisionById, SELECTABLE_REVISIONS } from "../../src/engine/revisions";
import { r2024 } from "../../src/engine/revisions/r2024";
import { r2026 } from "../../src/engine/revisions/r2026";
import { r2027_06 } from "../../src/engine/revisions/r2027-06";
import type { RevisionConsts } from "../../src/engine/revisions/types";
import { trial, type TrialResult } from "../../src/engine/trial";
import type { ClaimContext, EngineResult, Fact } from "../../src/engine/types";
import type { Evaluation } from "../../src/lifecycle/applications";
import type { Judge, Question } from "../../src/practice/practice";
import { day, YM } from "../helpers/period";
import { line, loadCase, withFact } from "./helpers";

const CASES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const K2 = loadCase("K2");
const K5 = loadCase("K5");
const K7 = loadCase("K7");
const unknown = { known: false } as const;

/** 症例の出来事・事実・施設の設定と、手入力の行（請求の版が導出しない区分の行）から、導出の入力を作る */
function inputOf(c: ClaimContext, choices: Record<string, string> = {}): DeriveInput {
  return { yearMonth: c.yearMonth, facility: c.facility, facts: c.facts, events: c.events, history: c.history, manual: manualLinesOf(c.lines, resolveRevision(c.yearMonth)), choices };
}
const compare = (c: ClaimContext, choices?: Record<string, string>) => compareRevisions(inputOf(c, choices), r2024, r2026);
const rowOf = (r: CompareResult, group: string) => r.rows.find((x) => x.group === group);
/** 比べやすい形：[前の版の区分, 回数, 点数] */
const side = (s: { kubun: string; count: number; points: number | null } | null | undefined) => (s ? [s.kubun, s.count, s.points] : null);

const EM = readFileSync(path.join(__dirname, "..", "..", "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
/** EM §2-9 の節（見出しから次の見出しまで） */
const EM_2_9 = (() => {
  const start = EM.indexOf("### 2-9. 令和6年度の値（比較用）");
  if (start < 0) throw new Error("evidence-master に §2-9 の節がない");
  const end = EM.indexOf("\n### ", start + 1);
  return EM.slice(start, end < 0 ? undefined : end);
})();
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const emRows = EM_2_9.split("\n").filter((l) => l.startsWith("| "));

describe("令和6年度の版（r2024）の持ち方", () => {
  it("COMPARE_REVISIONS に置き、REVISIONS には入れない。ルール・コード・摘要欄の記載は空", () => {
    expect(COMPARE_REVISIONS.map((r) => r.id)).toEqual(["r2024"]);
    expect(REVISIONS.map((r) => r.id)).toEqual(["r2026", "r2027-06"]);
    expect(SELECTABLE_REVISIONS.map((r) => r.id)).toEqual(["r2024", "r2026", "r2027-06"]);
    expect(revisionById("r2024")).toBe(r2024);
    expect(revisionById("r1999")).toBeUndefined();
    expect([r2024.rules, r2024.comments, r2024.changes, r2024.bundles]).toEqual([[], [], [], []]);
    expect([r2024.codes, r2024.uncoded, r2024.shikibetsu, r2024.commentCodes]).toEqual([{}, {}, {}, {}]);
    expect(r2024.label).toBe("令和6年度改定（最終状態）");
    // 期間は r2026 の直前まで（請求の判定には使わないので、続き方の検査の対象ではないが、重ねない）
    expect(r2024.effectiveUntil < r2026.effectiveFrom).toBe(true);
  });

  it("完了条件 6：2026年5月以前の診療年月は、今までどおり版がなく、resolveRevision・evaluate が例外", () => {
    for (const ym of [r2024.effectiveFrom, r2024.effectiveUntil]) {
      expect(hasRevision(ym)).toBe(false);
      expect(() => resolveRevision(ym)).toThrow(/版がない/);
      expect(() => evaluate({ ...K2, yearMonth: ym })).toThrow(/版がない/);
      expect(() => deriveLines({ ...inputOf(K2), yearMonth: ym })).toThrow(/版がない/);
    }
  });

  it("比較用の版の検査：id の重複（請求の判定に使う版とも）・期間の形・点数表の行の違いを断る", () => {
    expect(() => assertCompareRevisions(COMPARE_REVISIONS, REVISIONS)).not.toThrow();
    expect(() => assertCompareRevisions([{ ...r2024, id: "r2026" }], REVISIONS)).toThrow(/重複/);
    expect(() => assertCompareRevisions([r2024, r2024], REVISIONS)).toThrow(/重複/);
    expect(() => assertCompareRevisions([{ ...r2024, effectiveFrom: "2024-6" }], REVISIONS)).toThrow(/YYYY-MM/);
    expect(() => assertCompareRevisions([{ ...r2024, effectiveFrom: r2026.effectiveFrom }], REVISIONS)).toThrow(/終了月より後/);
    expect(() => assertCompareRevisions([{ ...r2024, points: {} }], REVISIONS)).toThrow(/空/);
    expect(() => assertCompareRevisions([{ ...r2024, points: { X: { name: "x", no: "x", points: -1, source: "EM" } } }], REVISIONS)).toThrow(/行が違う/);
    expect(() => assertCompareRevisions([{ ...r2024, points: { X: { name: "x", no: "x", points: null, source: "EM" } } }], REVISIONS)).toThrow(/行が違う/);
  });

  it("点数表は EM §2-9 の表の行だけで、点数と区分番号が表と一致する", () => {
    const table = new Map(emRows.map(cells).filter((c) => c.length === 7).map((c) => [c[0], c]));
    /** 表の書き方が数字 1 つでない行（採用の決定・注記による）。値はここで名指しして縛る */
    const special: Record<string, number | null> = { C001_N13_DX: 11, C001_N13_DX2: 9, D007_10: 103, A_IRYOJOHO: 1, A_DXSUISHIN: null };
    for (const [kubun, def] of Object.entries(r2024.points)) {
      const row = table.get(kubun);
      expect(row, kubun).toBeDefined();
      if (Object.hasOwn(special, kubun)) expect([kubun, def.points]).toEqual([kubun, special[kubun]]);
      else {
        expect([kubun, def.points]).toEqual([kubun, Number(row![3].replaceAll(",", ""))]);
        expect([kubun, def.no]).toEqual([kubun, row![2]]);
      }
    }
    // 名指しした値の出どころ：DX 加算は「採用（2026-11-20）」の行、D007_10 と令和6年度だけの区分は表の行
    expect(EM_2_9).toContain("加算1＝11・加算2＝9");
    expect(table.get("D007_10")![3].startsWith("103")).toBe(true);
    expect(table.get("A_IRYOJOHO")![3]).toContain("初診 1／再診 1");
    expect(table.get("A_DXSUISHIN")![3]).toContain("12／11／10／10／9／8");
    // EM が「（なし）」とした区分（令和8年度で新設）と、点数が未確認の D007_5・D007_8 は持たない
    for (const k of ["O100_1HA", "O100_1RO", "O100_1I", "A_DENSHI_RENKEI", "D007_5", "D007_8"]) expect([k, Object.hasOwn(r2024.points, k)]).toEqual([k, false]);
    // 令和8年度と同じ診療行為には同じキー：令和6年度だけの 2 区分のほかは、r2026 の点数表にあるキー
    expect(Object.keys(r2024.points).filter((k) => !Object.hasOwn(r2026.points, k))).toEqual(["A_IRYOJOHO", "A_DXSUISHIN"]);
    expect(Object.keys(r2024.points)).toHaveLength(47);
  });

  it("定数が指す区分は、物価対応料（令和8年度で新設）のほかは自分の点数表にある", () => {
    const c = r2024.consts;
    const refs = [...c.visitKubun, ...Object.values(c.kanri.table).flatMap((t) => Object.values(t)), c.hokatsu.kubun, c.rx.many, c.rx.other, ...c.baseUp.visit, c.baseUp.revisit, ...Object.values(c.terminal).filter((v) => typeof v === "string"), ...Object.values(c.oushin), ...c.tests.judgement, c.tests.bloodDraw, ...Object.values(c.testItems).flatMap((t) => [t.kubun, t.judgement]), ...Object.values(c.dx.tiers), c.ikou.kubun];
    expect(refs.filter((k) => !Object.hasOwn(r2024.points, k))).toEqual([]);
    expect([...c.price.visit, c.price.revisit].filter((k) => Object.hasOwn(r2024.points, k))).toEqual([]);
  });
});

describe("変わった点（Revision.changes）", () => {
  it("r2026 の changes は EM §2-9 の「変わった点」の行と 1 対 1 で、種類・要旨・出どころが行と同じ。要旨は 120 字まで", () => {
    const rows = new Map(emRows.map(cells).filter((c) => /^CH-\d+$/.test(c[0])).map((c) => [c[0], c]));
    expect(r2026.changes.map((c) => c.id)).toEqual([...rows.keys()]);
    expect(r2026.changes.length).toBe(19);
    for (const c of r2026.changes) {
      const [, target, kind, summary, em] = rows.get(c.id)!;
      expect([c.id, c.kind, c.summary, c.em]).toEqual([c.id, kind, summary, em]);
      for (const k of c.target.kubun ?? []) expect(target, c.id).toContain(k);
      if (c.target.ruleId) expect(target, c.id).toContain(`ルール ${c.target.ruleId}`);
      expect(c.summary.length, c.id).toBeLessThanOrEqual(120);
      // 対象の区分は、この版か、前の版（令和6年度だけの区分）の点数表にある
      for (const k of c.target.kubun ?? []) expect([c.id, k, Object.hasOwn(r2026.points, k) || Object.hasOwn(r2024.points, k)]).toEqual([c.id, k, true]);
      if (c.target.ruleId) expect(r2026.rules.map((r) => r.id), c.id).toContain(c.target.ruleId);
    }
  });

  it("値の変更の版は changes を引き継がない（空）", () => {
    expect(r2027_06.changes).toEqual([]);
  });
});

describe("注16 の有無を版の定数に通す（note16.enabled）", () => {
  /** 足す前の決め方（回数 → 重症 → 注16）。令和8年度の側が変わっていないことを、これと突き合わせて確かめる */
  function before(ctx: ClaimContext, c: RevisionConsts) {
    const visits = ctx.lines.filter((l) => c.visitKubun.includes(l.kubun)).reduce((s, l) => s + l.count, 0);
    if (visits === 0) return { known: true, value: "none" };
    if (visits === 1) return { known: true, value: "ニ" };
    const severe = ctx.facts.table8_2;
    if (!severe.known) return { known: false, need: "table8_2", candidates: ["イ", "ロ", "ニ"] };
    if (severe.value) return { known: true, value: "イ" };
    const met = ctx.facility.note16Met;
    if (!met.known) return { known: false, need: "facility.note16Met", candidates: [c.kanri.note16.from, c.kanri.note16.to] };
    return { known: true, value: met.value ? c.kanri.note16.from : c.kanri.note16.to };
  }
  const NOTE16: Fact<boolean>[] = [{ known: true, value: true }, { known: true, value: false }, unknown];
  const SEVERE: Fact<boolean>[] = [{ known: true, value: true }, { known: true, value: false }, unknown];

  it("r2026（真）：K1〜K7 と、注16・重症の全組み合わせで、足す前と同じ区分を返す", () => {
    expect(r2026.consts.kanri.note16.enabled).toBe(true);
    for (const name of CASES)
      for (const note16Met of NOTE16)
        for (const severe of SEVERE) {
          const c = withFact({ ...loadCase(name), facility: { ...loadCase(name).facility, note16Met } }, "table8_2", severe);
          expect([name, expectedKanri(c, r2026.consts).tier]).toEqual([name, before(c, r2026.consts)]);
        }
  });

  it("r2024（偽）：施設の設定 note16Met を読まず、月 2 回以上で重症でなければ 2ロ", () => {
    expect(r2024.consts.kanri.note16.enabled).toBe(false);
    for (const note16Met of NOTE16) {
      const c = { ...K7, facility: { ...K7.facility, note16Met } };
      expect(expectedKanri(c, r2024.consts).tier).toEqual({ known: true, value: "ロ" });
      const d = deriveLines(inputOf(c), r2024);
      expect(d.pending).toEqual([]);
      expect(d.basis.find((b) => b.kubun === "C002_2RO1")?.needs).toEqual(["comprehensiveCare", "residence", "table8_2"]);
    }
  });

  it("版にない区分の導出は、施設の設定を聞かずに飛ばす（物価対応料の設定が不明でも、令和6年度の側は保留にならない）", () => {
    const c = { ...K2, facility: { ...K2.facility, priceResponse: unknown } };
    expect(deriveLines(inputOf(c), r2024).pending).toEqual([]);
    expect(deriveLines(inputOf(c), r2026).pending.map((p) => p.kind === "事実不足" && p.need)).toEqual(["facility.priceResponse"]);
  });
});

describe("改定の比較（完了条件 5）", () => {
  it("K7：管理料は 1 行で「区分の変更」（令和6年度 2ロ(1) 3,685 → 令和8年度 2ニ(1) 2,285）", () => {
    const r = compare(K7);
    const kanri = r.rows.filter((x) => x.group === "在医総管");
    expect(kanri).toHaveLength(1);
    expect([side(kanri[0].from), side(kanri[0].to), kanri[0].change]).toEqual([["C002_2RO1", 1, 3685], ["C002_2NI1", 1, 2285], "区分の変更"]);
    expect([kanri[0].from!.name, kanri[0].to!.name]).toEqual([r2024.points.C002_2RO1.name, r2026.points.C002_2NI1.name]);
    // 「廃止」「新設」の 2 行に分けない
    expect(r.rows.filter((x) => x.from?.kubun === "C002_2RO1" || x.to?.kubun === "C002_2NI1")).toHaveLength(1);
    expect(r.totals).toEqual({ from: 6260, to: 4972 });
    // 注16 の文（CH-14）が、変わった点に入る
    expect(r.changes.map((c) => c.id)).toContain("CH-14");
  });

  it("K2：訪問診療料は「点数」（888 → 890、2 回）、物価対応料は「新設」。合計は令和6年度の側が EM §2-9 の 6,260、令和8年度の側が 6,372", () => {
    const r = compare(K2);
    const visit = rowOf(r, "C001_1I")!;
    expect([side(visit.from), side(visit.to), visit.change]).toEqual([["C001_1I", 2, 888], ["C001_1I", 2, 890], "点数"]);
    expect([visit.from!.subtotal, visit.to!.subtotal]).toEqual([1776, 1780]);
    const price = rowOf(r, "O100_1HA")!;
    expect([price.from, side(price.to), price.change]).toEqual([null, ["O100_1HA", 2, 3], "新設"]);
    expect(r.totals).toEqual({ from: 6260, to: 6372 });
    // 6,260 は EM §2-9 に書いてある数（採用の行）
    expect(EM_2_9).toMatch(/K2・K7 の令和6年度の合計は \*\*6,260\*\*/);
    expect(r.pending).toEqual({ from: [], to: [] });
    expect(r.unsupported).toEqual({ from: [], to: [] });
    // 行ごとの変わり方（EM §2-9 の K2 の内訳と同じ。管理料は 2ロ のまま）
    expect(Object.fromEntries(r.rows.map((x) => [x.group, x.change]))).toEqual({
      C001_1I: "点数",
      在医総管: "同じ",
      C002_N10_HOKATSU: "同じ",
      C002_N4_IKOU: "同じ",
      C001_N13_DX: "同じ",
      O001_3I: "点数",
      O100_1HA: "新設",
      D400_1: "同じ",
      D005_5: "同じ",
      D005_9: "同じ",
      D007_10: "同じ",
      D026_3: "同じ",
      D026_4: "同じ",
    });
    expect(side(rowOf(r, "O001_3I")!.from)).toEqual(["O001_3I", 2, 28]);
    // 変わった点は、行の区分か、行の区分を対象にするルール（CH-15 は R01）に関わるものだけ（再診料・一般名処方加算・BNP などの行は入らない）
    expect(r.changes.map((c) => c.id)).toEqual(["CH-01", "CH-05", "CH-06", "CH-10", "CH-11", "CH-12", "CH-14", "CH-15", "CH-19"]);
  });

  it("手入力の行に令和6年度にない区分がある請求でも例外にならず、その区分は「新設」と出る", () => {
    const input = { ...inputOf(K2), manual: [line("A_DENSHI_RENKEI"), line("C101_2I")] };
    // 絞らずに導出した行は、その版の判定で今までどおり「未知の区分」の例外になる（導出と請求の判定は変えていない）
    expect(() => evaluateWith({ ...K2, lines: deriveLines(input, r2024).lines }, r2024)).toThrow(/未知の区分: A_DENSHI_RENKEI/);
    const r = compareRevisions(input, r2024, r2026);
    const added = rowOf(r, "A_DENSHI_RENKEI")!;
    expect([added.from, side(added.to), added.change]).toEqual([null, ["A_DENSHI_RENKEI", 1, 2], "新設"]);
    // 両方の版にある手入力の行は、両側に出る
    expect(rowOf(r, "C101_2I")).toMatchObject({ change: "同じ", from: { points: 650 }, to: { points: 650 } });
    expect(r.totals).toEqual({ from: 6260 + 650, to: 6372 + 2 + 650 });
    expect(r.changes.map((c) => c.id)).toEqual(expect.arrayContaining(["CH-16", "CH-18"]));
    // 逆向き（後の版にない区分）は「廃止」
    const back = compareRevisions(input, r2026, r2024);
    expect(rowOf(back, "A_DENSHI_RENKEI")).toMatchObject({ to: null, change: "廃止" });
    expect(rowOf(back, "O100_1HA")).toMatchObject({ to: null, change: "廃止" });
  });

  it("導出だけを比べる：同じ版どうしは全部「同じ」。K1〜K7 のどれも、令和6年度の版で導出しても例外にならない", () => {
    for (const name of CASES) {
      const c = loadCase(name);
      const same = compareRevisions(inputOf(c), r2026, r2026);
      expect([name, [...new Set(same.rows.map((x) => x.change))]]).toEqual([name, same.rows.length ? ["同じ"] : []]);
      expect(same.totals.from).toBe(same.totals.to);
      expect(() => compare(c)).not.toThrow();
    }
  });

  it("保留があれば、その側の合計を出さない。点数表にはあるが行が立たなかった側は「新設」「廃止」と言わず「回数」", () => {
    // 令和8年度の側だけ注16 が不明：管理料が保留になり、令和6年度の側（注16 を読まない）には 2ロ の行がある
    const r = compare({ ...K2, facility: { ...K2.facility, note16Met: unknown } });
    expect(r.totals).toEqual({ from: 6260, to: null });
    expect(r.pending.to.map((p) => p.kind === "事実不足" && p.need)).toEqual(["facility.note16Met"]);
    expect(rowOf(r, "在医総管")).toMatchObject({ from: { kubun: "C002_2RO1" }, to: null, change: "回数" });
  });

  it("K5：令和6年度の側は、回数の要件を持たないのでターミナルケア加算を導出せず、合計を出さない（作り物の行で埋めない）", () => {
    const choices = (K5 as ClaimContext & { choices?: Record<string, string> }).choices ?? {};
    const r = compare(K5, choices);
    expect(r.unsupported.from.map((u) => u.code)).toEqual(["terminal_requirement"]);
    expect(r.totals.from).toBeNull();
    expect(r.totals.to).toBe(10175 + 76 + 4 + 2);
    expect(rowOf(r, "C001_N6_TERMINAL")).toMatchObject({ from: null, to: { points: 4500 }, change: "回数" });
    // 看取り加算は、両側とも本人が選んだものだけ
    expect(rowOf(r, "C001_N7_MITORI")).toMatchObject({ change: "同じ", from: { points: 3000 }, to: { points: 3000 } });
  });

  it("tentative：月の途中の見込みの行と、保留が待たせている区分の行に付く", () => {
    const mid = compareRevisions({ ...inputOf(K2), asOf: day(20) }, r2024, r2026);
    expect(rowOf(mid, "在医総管")).toMatchObject({ from: { tentative: true }, to: { tentative: true } });
    expect(rowOf(mid, "C001_1I")).toMatchObject({ from: { tentative: false }, to: { tentative: false } });
  });
});

describe("版を選ぶ試算（完了条件 (c)(d)）", () => {
  const derivedK2 = (rev = r2026): ClaimContext => ({ ...K2, lines: deriveLines({ ...inputOf(K2), manual: [] }, rev).lines });

  it("(d) 版を省いた呼び出しは変わらない：evaluate は、診療年月の版を渡した evaluateWith と同じ結果。K1〜K7 の合計も同じ", () => {
    const totals: Record<string, number | null> = {};
    for (const name of CASES) {
      const c = loadCase(name);
      expect(evaluate(c)).toEqual(evaluateWith(c, resolveRevision(c.yearMonth)));
      totals[name] = evaluate(c).total;
    }
    expect(totals).toEqual({ K1: 14806, K2: 6372, K3: 16260, K4: 4540, K5: 10175, K6: 274, K7: 4972 });
    // K5 の導出の合計（往診の日の再診料と「再診時等」の区分を足した数）
    const choices = (K5 as ClaimContext & { choices?: Record<string, string> }).choices ?? {};
    expect(evaluate({ ...K5, lines: deriveLines(inputOf(K5, choices)).lines }).total).toBe(10257);
  });

  it("試算の結果は、試算の印（版・診療年月・適用期間の中か）と、ルールを持つ版かを必ず持つ。判定の中身は evaluateWith と同じ", () => {
    const now = trial(derivedK2(), r2026);
    const { revisionId, applied: _applied, ...rest } = evaluateWith(derivedK2(), r2026);
    expect(now).toEqual({ ...rest, trial: { revisionId, claimYearMonth: YM, inPeriod: true }, rulesAvailable: true });
    expect(now.total).toBe(6372);
    expect(Object.keys(now)).not.toContain("revisionId");
    expect(Object.keys(now)).not.toContain("applied");

    // ルールのない版（令和6年度）：算定行と点数だけ。適用期間の外
    const old = trial(derivedK2(r2024), r2024);
    expect(old.trial).toEqual({ revisionId: "r2024", claimYearMonth: YM, inPeriod: false });
    expect([old.rulesAvailable, old.findings, old.total]).toEqual([false, [], 6260]);
    // 値の変更の版（適用期間の外）でも試算できる。日付は記録のまま
    const next = trial(derivedK2(r2027_06), r2027_06);
    expect([next.trial.inPeriod, next.rulesAvailable, next.total]).toEqual([false, true, 6372 + (158 - 79) * 2 + (6 - 3) * 2]);
  });

  it("(c) 試算の結果を、提出の確定・適用記録・防いだ額の入口に渡すコードは、型検査で落ちる", () => {
    const t: TrialResult = trial(derivedK2(), r2026);
    const ctx = derivedK2();
    // 判定の結果を受ける場所に渡せない（revisionId・applied がない）
    // @ts-expect-error TrialResult は EngineResult ではない
    const asEngine: EngineResult = t;
    // 提出の確定の判定関数（Judge）に、試算は使えない
    // @ts-expect-error 試算を返す関数は Judge ではない
    const judge: Judge = (c) => trial(c, r2026);
    // 本人が確定した算定行の判定（防いだ額が読む。提出の確定もここから作る）に入れられない
    // @ts-expect-error 確定の記録に試算の結果は入らない
    const confirmed: NonNullable<Question["confirmed"]> = { lines: ctx.lines, result: t, at: "" };
    // 適用記録の入力（当たったルール）に詰め替えられない：試算の結果は applied を持たない
    // @ts-expect-error TrialResult に applied はない
    const evaluation: Evaluation = { ctx, applied: t.applied };
    // 上の 4 行は、型検査（npm run typecheck）が落とすことが目的。ここでは、試算の結果がその 2 つの項目を持たないことだけを確かめる
    expect([asEngine, judge, confirmed, evaluation]).toHaveLength(4);
    expect("revisionId" in t || "applied" in t).toBe(false);
  });
});
