// design.md §12-4：partial をルールごとに決める。各ルールは、判定に使う行の範囲を reads（区分の一覧）で申告する。
// 申告を縛る（C-105）：同梱の症例と練習問題の入力それぞれについて、版の点数表の区分を 1 つずつ取り、
// 「そのルールの reads にない区分の行を足しても消しても、そのルールの指摘（情報不足を含む）が変わらない」を確かめる。変われば、その区分は reads に入っていなければならない。
// 単調性（§11-11）も、ルールごとの partial で回す。マスターは使わない：区分番号は、版の点数表の区分番号の表示（EM の採用値）から作った手作りの表で渡す
import { describe, expect, it } from "vitest";
import { loadSources } from "../../scripts/gen-uke";
import { evaluate, partialBy, rulesOf } from "../../src/engine";
import { kanriKubun } from "../../src/engine/predicates";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext, Finding, Outside, Rule } from "../../src/engine/types";
import { DOCTOR_DRILLS } from "../../src/practice/doctor-drills";
import { DRILLS } from "../../src/practice/drills";
import { commentsOfCase } from "../../src/uke/cases";
import { day, YM } from "../helpers/period";
import { FAKE_A } from "./fake-revisions";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const NAMES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const rev = resolveRevision(YM);
const { src } = loadSources();
const ukeCase = (name: string): ClaimContext => {
  const c = loadCase(name);
  return { ...c, comments: commentsOfCase(c, src.commentValues?.[c.claimId]), commentsKnown: true };
};
const noRecords = (c: ClaimContext): ClaimContext => ({ ...c, events: [], recordsKnown: false });
const nameOf = (claimId: string) => claimId.split("-")[0];
const K1 = loadCase("K1");
const K5 = loadCase("K5");

/** 入力：同梱の症例（症例の JSON の形・UKE から作った形・記録のない形）と、練習問題。間違いを 1 つ入れた入力も足す（指摘が出ている状態でも変わらないことを見る） */
const INPUTS: { name: string; ctx: ClaimContext }[] = [
  ...NAMES.flatMap((n) => [
    { name: n, ctx: loadCase(n) },
    { name: `${n}（UKE）`, ctx: ukeCase(n) },
    { name: `${n}（UKE・記録なし）`, ctx: noRecords(ukeCase(n)) },
  ]),
  ...DRILLS.map((d) => ({ name: `練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  ...DOCTOR_DRILLS.map((d) => ({ name: `医師確認の練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  ...DRILLS.map((d) => ({ name: `練習 ${d.id}（UKE・記録なし）`, ctx: noRecords(d.make(ukeCase(nameOf(d.claimId)))) })),
  { name: "K1 訪問診療料なし", ctx: without(K1, "C001_1I") },
  { name: "K1（UKE）訪問診療料なし", ctx: without(ukeCase("K1"), "C001_1I") },
  { name: "K5＋死亡診断加算", ctx: withLines(K5, line("C001_N8_SHIBOU", 1, K5.lines.find((l) => l.kubun === "C001_N7_MITORI")!.dates)) },
  { name: "K1＋同じ日の往診料", ctx: withLines(ukeCase("K1"), line("C000", 1, [K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0]])) },
  { name: "K1＋外来迅速検体検査加算", ctx: withLines(K1, line("D_GAIRAI_JINSOKU", 1, [day(20)])) },
  // 訪問診療料の日の「再診時等」（R08・R15 の指摘が出ている状態。その日に往診料を足すと、指摘が変わる）
  { name: "K1＋訪問診療料の日の再診時等のベースアップ評価料", ctx: withLines(K1, line(rev.consts.baseUp.revisit, 1, [K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0]])) },
  { name: "K1＋訪問診療料の日の再診時等の物価対応料", ctx: withLines(K1, line(rev.consts.price.revisit, 1, [K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0]])) },
];

const ofRule = (fs: Finding[], id: string) => JSON.stringify(fs.filter((f) => f.ruleId === id));
const readsOf = (rule: Rule, r: Revision) => rule.reads!(r);

/** 申告に反するもの：reads にない区分の行を足す・消すと、そのルールの指摘が変わる */
function violations(revs?: Revision[]): string[] {
  const r = revs ? resolveRevision(YM, revs) : rev;
  const out = new Set<string>();
  for (const { name, ctx } of INPUTS) {
    const before = evaluate(ctx, revs).findings;
    // 足す行の日：請求にある日のそれぞれと、どの行にもない日
    const days = [...new Set(ctx.lines.flatMap((l) => l.dates)), day(3)];
    for (const k of Object.keys(r.points)) {
      const variants: { what: string; ctx: ClaimContext }[] = days.map((d) => ({ what: `${k} を ${d} に足す`, ctx: withLines(ctx, line(k, 1, [d])) }));
      if (ctx.lines.some((l) => l.kubun === k)) variants.push({ what: `${k} を消す`, ctx: without(ctx, k) });
      for (const v of variants) {
        const after = evaluate(v.ctx, revs).findings;
        for (const rule of r.rules) if (!readsOf(rule, r).includes(k) && ofRule(before, rule.id) !== ofRule(after, rule.id)) out.add(`${rule.id} は ${k} を読んでいる（${name}：${v.what}）`);
      }
    }
  }
  return [...out];
}

describe("reads の申告を縛る（design.md §12-4。C-105）", () => {
  it("どのルールも reads を申告し、kubun を含み、版の点数表にある区分だけを挙げる", () => {
    for (const r of REVISIONS)
      for (const rule of r.rules) {
        const reads = readsOf(rule, r);
        expect(rule.kubun.filter((k) => !reads.includes(k)), `${r.id} ${rule.id}`).toEqual([]);
        expect(reads.filter((k) => !Object.hasOwn(r.points, k)), `${r.id} ${rule.id}`).toEqual([]);
        expect(new Set(reads).size, `${r.id} ${rule.id}`).toBe(reads.length);
      }
  });

  it("同梱の症例と練習問題の入力に、reads にない区分の行を足しても消しても、そのルールの指摘（情報不足を含む）は変わらない", () => {
    expect(violations()).toEqual([]);
  }, 120_000);

  it("空振りしていない：述語を通して読む区分を reads から外すと、この検査に掛かる（R01 の訪問診療料、R02・R03 の訪問診療料、R11 の訪問診療料、R08・R15 の往診料）", () => {
    const drop = (ruleId: string, kubun: string[]): Revision[] =>
      REVISIONS.map((r) => ({ ...r, rules: r.rules.map((x) => (x.id === ruleId ? { ...x, reads: () => readsOf(x, r).filter((k) => !kubun.includes(k)) } : x)) }));
    const c = rev.consts;
    for (const [ruleId, kubun] of [["R01", c.visitKubun], ["R02", c.visitKubun], ["R03", c.visitKubun], ["R11", c.visitKubun], ["R08", [c.oushin.kubun]], ["R15", [c.oushin.kubun]]] as const) {
      const bad = violations(drop(ruleId, [...kubun]));
      expect(bad.some((b) => b.startsWith(`${ruleId} は `)), ruleId).toBe(true);
    }
  }, 300_000);

  it("kubun より広い申告：R02・R03（訪問診療料）、R08・R15・R11（訪問診療料・往診料）。ほかは kubun と同じ（R17 の kubun は、訪問診療料・往診料・管理料をもう含んでいる）", () => {
    const extra = Object.fromEntries(rev.rules.map((r) => [r.id, readsOf(r, rev).filter((k) => !r.kubun.includes(k))]).filter(([, x]) => x.length > 0));
    const c = rev.consts;
    expect(extra).toEqual({
      R02: c.visitKubun,
      R03: c.visitKubun,
      R08: [...c.visitKubun, c.oushin.kubun],
      R11: [...c.visitKubun, c.oushin.kubun],
      R15: [...c.visitKubun, c.oushin.kubun],
      // R17 の kubun は摘要欄の記載の表（EM §2-10 表 1）の区分。管理料は在支診（強化型以外）の区分だけが表にあるので、ほかの種別の管理料は reads だけにある
      R17: kanriKubun(c).filter((k) => !rev.rules.find((r) => r.id === "R17")!.kubun.includes(k)),
    });
    const r17 = readsOf(rev.rules.find((r) => r.id === "R17")!, rev);
    expect([...c.visitKubun, c.oushin.kubun, ...c.kanri.rows.map((r) => r.kubun)].filter((k) => !r17.includes(k))).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ルールごとの partial。区分番号の鍵は、版の点数表の区分番号の表示の先頭（"C002-2 2 イ(1)" → "C002"。枝番は入れない）から作る

const noKey = (kubun: string) => rev.points[kubun].no.split(" ")[0].replace(/-\d+$/, "");
const NO_OF: Record<string, string[]> = Object.fromEntries(Object.keys(rev.points).map((k) => [k, [noKey(k)]]));
/** 対象外の単位にあるコード（マスターにある）。no は区分番号の鍵（医薬品・特定器材は null） */
const outside = (...codes: { code: string; no: string | null; known?: boolean }[]): Outside => ({ codes: codes.map((c) => ({ known: true, ...c })), noOf: NO_OF });
const codeOf = (kubun: string) => rev.codes[kubun]?.primary ?? `包括:${kubun}`;
const keyOf = (f: Finding) => f.messageKey.slice(f.ruleId.length + 1);
const claimsOf = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.kind !== "情報不足");

describe("partial をルールごとに決める（design.md §12-4）", () => {
  it("単調性：行を 1 行ずつ・1 区分ずつ対象外に移し、移した行のコードと区分番号を渡す。出た指摘は、移す前の入力でも同じ行に出ている", () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const { name, ctx } of INPUTS) {
      const full = claimsOf(ctx);
      const groups = [...ctx.lines.map((l) => [l.kubun]), ...[...new Set(ctx.lines.map((l) => l.kubun.split("_")[0]))].map((g) => ctx.lines.filter((l) => l.kubun.split("_")[0] === g).map((l) => l.kubun))];
      for (const g of groups) {
        const moved: ClaimContext = { ...ctx, lines: ctx.lines.filter((l) => !g.includes(l.kubun)), partial: true, outside: outside(...[...new Set(g)].map((k) => ({ code: codeOf(k), no: noKey(k) }))) };
        for (const f of claimsOf(moved)) {
          seen.add(f.messageKey);
          const same = full.some((x) => x.messageKey === f.messageKey && x.params?.rule === f.params?.rule && f.lineRefs.every((k) => x.lineRefs.includes(k)));
          if (!same) bad.push(`${name}／${g.join(",")} を移すと ${f.messageKey}（${f.lineRefs.join(",")}）が新しく出る`);
        }
      }
    }
    expect(bad).toEqual([]);
    // 空振りしていない：v23 では止まっていた種類（soundWhenPartial に申告のない種類）も、関係のない行を移しただけなら出ている
    const sound = new Set(rulesOf(YM).flatMap((r) => r.soundWhenPartial.map((k) => `${r.id}.${k}`)));
    expect([...seen].filter((k) => !sound.has(k)).length).toBeGreaterThan(0);
    expect([...seen]).toContain("R01.no_visit");
  });

  it("空振りしていない：R01 の reads から訪問診療料を外すと、訪問診療料を対象外に移した入力で「訪問診療料のない月」が新しく出る", () => {
    const r01 = { ...rev.rules.find((r) => r.id === "R01")!, reads: () => rev.consts.kanri.rows.map((r) => r.kubun) };
    const revs = REVISIONS.map((r) => (r.id === rev.id ? { ...r, rules: r.rules.map((x) => (x.id === "R01" ? r01 : x)) } : r));
    const moved: ClaimContext = { ...without(K1, "C001_1I"), partial: true, outside: outside({ code: codeOf("C001_1I"), no: noKey("C001_1I") }) };
    expect(evaluate(moved, revs).findings.filter((f) => f.ruleId === "R01").map(keyOf)).toEqual(["no_visit"]);
    expect(evaluate(moved).findings.filter((f) => f.ruleId === "R01").map((f) => f.missing?.field)).toEqual(["unsupportedLines"]);
  });

  /** 訪問診療料のない月の在医総管（K1 から訪問診療料を除いたもの）に、対象外の単位が 1 つある */
  const noVisit = (o?: Outside): ClaimContext => ({ ...without(K1, "C001_1I"), partial: true, ...(o ? { outside: o } : {}) });

  it("関係のない区分番号のコードを 1 行足す：どのルールの指摘も、対象外の単位がない請求と変わらない。合計は出さず、小計を別に返す", () => {
    const whole = evaluate(without(K1, "C001_1I"));
    for (const o of [outside({ code: "尿検査の判断料", no: "D999" }), outside({ code: "医薬品", no: null })]) {
      const r = evaluate(noVisit(o));
      expect(r.findings).toEqual(whole.findings);
      expect(r.findings.filter((f) => f.ruleId === "R01").map(keyOf)).toEqual(["no_visit"]);
      expect([r.total, r.subtotal, r.applied]).toEqual([null, whole.total, whole.applied]);
    }
  });

  it("reads の区分と同じ区分番号の別コードを 1 行足す：そのルールだけ partial になり（v23 と同じ結果）、関係のないルールは止まらない", () => {
    const whole = evaluate(without(K1, "C001_1I")).findings;
    const v23 = evaluate(noVisit()).findings;
    // 訪問診療料(Ⅱ) のような、訪問診療料と同じ区分番号（C001）の別コード
    const input = noVisit(outside({ code: "訪問診療料の別コード", no: noKey("C001_1I") }));
    const r = evaluate(input).findings;
    expect(r.filter((f) => f.ruleId === "R01")).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "clerk", field: "unsupportedLines" } })]);
    const stopped = rev.rules.filter((rule) => partialBy(rule, rev, input) !== null).map((rule) => rule.id);
    expect(stopped).toEqual(rev.rules.filter((rule) => rule.reads!(rev).some((k) => noKey(k) === "C001")).map((rule) => rule.id));
    expect(stopped).toEqual(expect.arrayContaining(["R01", "R02", "R03", "R08", "R09", "R10", "R11", "R12", "R13", "R15", "R17"]));
    for (const rule of rev.rules) expect(ofRule(r, rule.id), rule.id).toBe(ofRule(stopped.includes(rule.id) ? v23 : whole, rule.id));
    // 止まらないルールがある（在宅療養指導管理料・管理料の族・処方箋料など）
    expect(rev.rules.map((x) => x.id).filter((id) => !stopped.includes(id))).toEqual(expect.arrayContaining(["R04", "R06", "R07", "R16"]));
  });

  it("マスターにないコードが 1 つでもあれば、どのルールも partial（v23 と同じ結果）", () => {
    const input = noVisit(outside({ code: "999999999", no: null, known: false }));
    expect(evaluate(input).findings).toEqual(evaluate(noVisit()).findings);
    for (const rule of rev.rules) expect(partialBy(rule, rev, input), rule.id).toEqual([{ code: "999999999", known: false, no: null }]);
  });

  it("ルールごとに決められないとき（基本マスターがない／reads の申告がない／読む区分の区分番号が引けない）は、どのルールも partial", () => {
    const r01 = rev.rules.find((r) => r.id === "R01")!;
    const o = outside({ code: "医薬品", no: null });
    expect(partialBy(r01, rev, { partial: true })).toBe("all");
    expect(partialBy(FAKE_A.rules[0], FAKE_A, { partial: true, outside: o })).toBe("all");
    expect(partialBy(r01, rev, { partial: true, outside: { ...o, noOf: { ...NO_OF, C001_1I: [] } } })).toBe("all");
    expect(partialBy(r01, rev, { partial: true, outside: o })).toBeNull();
    // 対象外の単位がなければ、渡されていても partial でない
    expect(partialBy(r01, rev, { outside: outside({ code: "x", no: null, known: false }) })).toBeNull();
  });

  it("R17：関係のない行が対象外にあるだけなら、条件つきの記載の記載もれも、訪問日の突き合わせも、今までどおり指摘になる", () => {
    const visit = K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0];
    const base: ClaimContext = { ...withLines(ukeCase("K1"), line("C000", 1, [visit])), comments: ukeCase("K1").comments };
    const r17 = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R17").map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : `${keyOf(f)}:${f.params?.rule}`));
    expect(r17({ ...base, partial: true })).toEqual(["情報不足:unsupportedLines"]);
    expect(r17({ ...base, partial: true, outside: outside({ code: "医薬品", no: null }) })).toEqual(r17(base));
    expect(r17(base)).toEqual(["comment_missing:T162-reason"]);
    expect(r17({ ...base, partial: true, outside: outside({ code: "往診料の別コード", no: noKey("C000") }) })).toEqual(["情報不足:unsupportedLines"]);
  });

  it("事実だけで決まる指摘は、どちらでも出る（R06 の対象外の主病）", () => {
    const c = withFact(withLines(without(K1, "C002_2I1", "C002_N15_RENKEI"), line("F400_N4")), "mainDisease", { known: true, value: "糖尿病" });
    for (const o of [undefined, outside({ code: "処方箋料の別コード", no: noKey("F400_N4") }), outside({ code: "医薬品", no: null })])
      expect(evaluate({ ...c, partial: true, ...(o ? { outside: o } : {}) }).findings.filter((f) => f.ruleId === "R06" && f.kind !== "情報不足").map(keyOf)).toContain("excluded_disease");
  });
});
