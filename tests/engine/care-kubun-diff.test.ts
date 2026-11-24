// 版の区分を足す前と後の、合成の UKE の点検の結果の差（design.md §18-11。v37 21c）：C001_2I・C001_2RO・C007・C010 を版に入れると、
// 今まで「点検の対象外の単位」だった行が点検の行になり、partial の扱いと合計が変わる。足す前の版（4 区分と R20・R21 を除いたもの）と、今の版で同じ UKE を読み比べる。
// 訪問診療料(Ⅰ)2 の行がある請求では、(Ⅰ)2 と同じ区分番号を読む既存のルールを、足す前と同じ「決められない」に置く（design.md §18-12 の 8。当面の形）：
// 足す前と後で、既存のルールの確定の指摘が増えないことをここで縛る
import { describe, expect, it } from "vitest";
import { evaluateWith } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext, Outside } from "../../src/engine/types";
import { UNKNOWN_FACTS } from "../../src/server/app/cases";
import { findingText } from "../../src/messages";
import { mapClaim, parseUke, writeUke } from "../../src/uke/uke";
import { fileOf, receiptOf } from "../helpers/care";
import { line, loadCase, withLines } from "./helpers";
import { day, YM } from "../helpers/period";

const ADDED = ["C001_2I", "C001_2RO", "C007", "C010"];
const after = resolveRevision(YM);
const omit = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => !ADDED.includes(k)));
/** 足す前の版：4 区分の点数・コード・診療識別と、R20・R21・その定数を除き、reads から足した区分を外す */
const before: Revision = {
  ...after,
  points: omit(after.points),
  codes: omit(after.codes),
  shikibetsu: omit(after.shikibetsu),
  consts: { ...after.consts, visit2Kubun: undefined, care: undefined },
  rules: after.rules.filter((r) => r.id !== "R20" && r.id !== "R21").map((r) => ({ ...r, reads: (x: Revision) => r.reads!.call(r, x).filter((k) => !ADDED.includes(k)) })),
};

/** 区分番号の鍵（基本マスターの代わりに、版の点数表の区分番号の表示の頭を使う。tests/engine/reads.test.ts と同じ作り方） */
const noOf = (rev: Revision, kubun: string) => rev.points[kubun].no.split(" ")[0];
/** 足す前の版で対象外の単位になったコードを、基本マスターがある請求と同じ形にする（コード → 今の版の区分 → 区分番号） */
function outsideOf(codes: string[]): Outside {
  const kubunOf = (code: string) => Object.entries(after.codes).find(([, d]) => d.primary === code || d.accept.includes(code))![0];
  return { codes: [...new Set(codes)].map((code) => ({ code, known: true, no: noOf(after, kubunOf(code)) })), noOf: Object.fromEntries(Object.keys(before.points).map((k) => [k, [noOf(before, k)]])) };
}

/** 請求を版 rev で読んで判定する。masters は、足す前の対象外の単位を基本マスターのある請求として渡すか */
function judgeCtx(rev: Revision, c: ClaimContext, masters: boolean) {
  const claim = parseUke(writeUke(fileOf([receiptOf(1, YM, c.lines)]))).claims[0];
  const m = mapClaim(claim, rev);
  const others = m.others.flatMap((o) => o.codes);
  const ctx: ClaimContext = { ...c, lines: m.lines, comments: m.comments, commentsKnown: true, ...(others.length ? { partial: true, ...(masters ? { outside: outsideOf(others) } : {}) } : {}) };
  const r = evaluateWith(ctx, rev);
  return {
    lines: m.lines.map((l) => l.kubun),
    others,
    total: r.total,
    subtotal: r.subtotal,
    unsupported: r.findings.filter((f) => f.missing?.field === "unsupportedLines").map((f) => f.ruleId),
    findings: r.findings.filter((f) => f.kind !== "情報不足").map((f) => f.messageKey),
    /** 確定の指摘（条件つきを除く） */
    certain: r.findings.filter((f) => f.kind !== "情報不足" && f.params?.conditional !== "1").map((f) => `${f.messageKey}:${f.lineRefs.join(",")}`),
  };
}
const base = (facts = UNKNOWN_FACTS): ClaimContext => ({ ...loadCase("K1"), claimId: "X", facts, events: [], recordsKnown: false, lines: [] });
const judge = (rev: Revision, lines: ClaimContext["lines"], facts = UNKNOWN_FACTS, masters = false) => judgeCtx(rev, { ...base(facts), lines }, masters);

describe("版の区分を足す前と後（design.md §18-11）", () => {
  const lines = [
    { kubun: "C001_1I", count: 1, dates: [day(6)] },
    { kubun: "C002_2NI1", count: 1, dates: [day(6)] },
    { kubun: "C001_2I", count: 1, dates: [day(13)] },
    { kubun: "C007", count: 1, dates: [day(6)] },
    { kubun: "C010", count: 1, dates: [day(6)] },
  ];
  const b = judge(before, lines);
  const a = judge(after, lines);

  it("足す前は 4 区分の行が対象外の単位（partial。合計なし・小計あり）で、足した後は点検の行（合計あり）", () => {
    expect(b.others.sort()).toEqual(["114008010", "114015310", "114042110"]);
    expect(b.lines).toEqual(["C001_1I", "C002_2NI1"]);
    expect([b.total, typeof b.subtotal]).toEqual([null, "number"]);
    expect(a.others).toEqual([]);
    expect(a.lines).toEqual(["C001_1I", "C002_2NI1", "C001_2I", "C007", "C010"]);
    expect(typeof a.total).toBe("number");
    expect(a.subtotal).toBeUndefined();
  });

  it("申告のない請求では R20・R21 は何も言わない。ほかのルールの指摘は、(Ⅰ)1 と (Ⅰ)2 が同じ月なので R17 の T176（在医総管の月の訪問日の記載）が判定不能になって消えるほかは同じ（U-67）", () => {
    expect(a.findings.filter((k) => k.startsWith("R20") || k.startsWith("R21"))).toEqual([]);
    expect({ added: a.findings.filter((k) => !b.findings.includes(k)), removed: b.findings.filter((k) => !a.findings.includes(k)) }).toEqual({ added: [], removed: ["R17.comment_missing"] });
  });
});

/** 判定だけを見る請求（K1 の施設の設定と事実。出来事なし・コメントなし） */
const ev = (lines: ClaimContext["lines"], more: Partial<ClaimContext> = {}) => evaluateWith({ ...base(loadCase("K1").facts), lines, commentsKnown: false, ...more }, after).findings;
const keysOf = (fs: ReturnType<typeof ev>, ...ids: string[]) => fs.filter((f) => ids.includes(f.ruleId) && f.missing?.field !== "chartRecord").map((f) => (f.kind === "情報不足" ? `${f.ruleId}:${f.missing?.field}` : `${f.messageKey}${f.params?.conditional === "1" ? "(条件つき)" : ""}`));

describe("訪問診療料(Ⅰ)2 の扱い（EM §2-14 の「ルールごとの扱い」。v38）", () => {
  const v2 = (n: number, dates = [day(20)]) => line("C001_2I", n, dates);
  it("R01・R02・R03（W-112・W-113・W-114・U-67〜U-69）：(Ⅰ)2 だけの月は条件つき 1 件（前提「当院が主治医の機関でなければ」）。(Ⅰ)1 と (Ⅰ)2 が同じ月は判定不能で 1 回だけ聞き、R02・R03 は黙る", () => {
    expect(keysOf(ev([v2(2, [day(6), day(20)]), line("C002_2RO1", 1, [day(20)])]), "R01", "R02", "R03")).toEqual(["R01.visit2_only(条件つき)"]);
    const f = ev([v2(2, [day(6), day(20)]), line("C002_2RO1", 1, [day(20)])]).find((x) => x.messageKey === "R01.visit2_only")!;
    expect(findingText(f)).toMatch(/^当院が主治医の機関でなければ、/);
    expect(keysOf(ev([line("C001_1I", 1, [day(6)]), v2(1), line("C002_2RO1", 1, [day(20)]), line("C002_N10_HOKATSU", 1, [day(20)])]), "R01", "R02", "R03")).toEqual(["R01:visit2Mixed"]);
    // 足す前は R01 が決められなかった請求（(Ⅰ)2 は対象外の単位）
    const only2 = [{ kubun: "C001_2I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
    expect(judge(before, only2, loadCase("K1").facts).unsupported).toContain("R01");
  });
  it("R13・R17 の週の上限（W-118・W-119）：(Ⅰ)2 は週の回数に入らない", () => {
    expect(keysOf(ev([line("C001_1I", 3, [day(4), day(5), day(6)]), v2(1, [day(7)])]), "R13")).toEqual([]);
  });
  it("R08・R15（W-115〜W-117）：(Ⅰ)2 の日は訪問診療時の区分（oushin_only_day を言わない）。(Ⅰ)2 だけの日の再診時等は区分誤り", () => {
    expect(keysOf(ev([line("C001_1I", 1, [day(6)]), v2(1), line("O001_3I", 2, [day(6), day(20)]), line("O100_1HA", 2, [day(6), day(20)])]), "R08", "R15")).toEqual([]);
    expect(keysOf(ev([line("C001_1I", 1, [day(6)]), v2(1), line("O001_3I", 1, [day(6)]), line("O001_2", 1, [day(20)]), line("O100_1HA", 1, [day(6)]), line("O100_1RO", 1, [day(20)])]), "R08", "R15")).toEqual(["R08.use_visit", "R15.use_visit"]);
  });
  it("R10（W-122）：(Ⅰ)2 の日の往診料は、(Ⅰ)1 と同じく同じ日の関係を確かめる", () => {
    expect(keysOf(ev([v2(1), line("C000", 1, [day(20)])]), "R10")).toEqual(["R10:sameDayOushinAfterVisit"]);
  });
  it("R11（W-125。U-70）：(Ⅰ)2 の日の外来迅速検体検査加算は、記録がなければ条件つき", () => {
    const facts = { ...loadCase("K1").facts, rapidSameDayDocumented: { known: true as const, value: false } };
    expect(keysOf(evaluateWith({ ...base(facts), lines: [v2(1), line("D_GAIRAI_JINSOKU", 1, [day(20)])], commentsKnown: false }, after).findings, "R11")).toEqual(["R11.rapid_needs_same_day_doc_visit2(条件つき)"]);
  });
  it("R09（W-120・U-72）：(Ⅰ)2 だけの月の C001 の加算は、前の月に (Ⅰ)1 がなく死亡日に往診料もなければ確定。前の月を取り込んでいない・死亡日に往診料があれば「見ていません」", async () => {
    const { visit2ScopeNotes, VISIT2_TERMINAL_NOTE } = await import("../../src/engine/visit2");
    const lines = [v2(1), line("C001_N8_SHIBOU", 1, [day(20)])];
    expect(keysOf(ev(lines, { prevMonthVisit1: false }), "R09")).toEqual(["R09.addition_needs_visit1"]);
    for (const more of [{ prevMonthVisit1: null }, { prevMonthVisit1: true }]) {
      expect(keysOf(ev(lines, more), "R09")).toEqual([]);
      expect(visit2ScopeNotes({ lines, ...more }, after.consts)).toEqual([VISIT2_TERMINAL_NOTE]);
    }
    expect(keysOf(ev([...lines, line("C000", 1, [day(20)])], { prevMonthVisit1: false }), "R09")).toEqual([]);
  });
  it("R17 T176：(Ⅰ)2 だけの月は決めていない（情報不足。文は対象外の行と言わない）、(Ⅰ)1 と (Ⅰ)2 が同じ月は黙る（R01 が聞く）", () => {
    const k2 = loadCase("K2");
    const withV2 = (c: ClaimContext) => ({ ...c, commentsKnown: true, comments: [] });
    const only = evaluateWith(withV2({ ...k2, lines: [v2(2, [day(6), day(20)]), line("C002_2RO1", 1, [day(20)])] }), after).findings.filter((f) => f.ruleId === "R17" && f.params?.rule === "T176-date");
    expect(only.map((f) => f.missing?.field)).toEqual(["visit2Undecided"]);
    expect(findingText(only[0])).not.toContain("対象外");
    const mixed = evaluateWith(withV2({ ...k2, lines: [line("C001_1I", 1, [day(6)]), v2(1), line("C002_2RO1", 1, [day(20)])] }), after).findings.filter((f) => f.ruleId === "R17" && f.params?.rule === "T176-date");
    expect(mixed).toEqual([]);
  });
});

describe("導出で (Ⅰ)2 の行が入力にある月（EM §2-14 の 2-2）", () => {
  it("訪問の出来事は (Ⅰ)1 と決められず立てない（visit2_pending）。保留の訪問から D03〜D05・D10・D11・D12 を立てない。(Ⅰ)2 の日は D06・D07（3 イ）・D08 で訪問診療の日", async () => {
    const { deriveLines } = await import("../../src/engine/derive");
    const K1 = loadCase("K1");
    const input = { yearMonth: K1.yearMonth, facility: K1.facility, facts: K1.facts, history: K1.history, choices: {} };
    const held = deriveLines({ ...input, events: K1.events, manual: [line("C001_2I", 1, [day(9)])] });
    expect(held.unsupported.map((u) => u.code)).toContain("visit2_pending");
    expect(held.basis.filter((b) => ["D01", "D03", "D04", "D05", "D10", "D11", "D12"].includes(b.derive))).toEqual([]);
    // 出来事に訪問がない月：(Ⅰ)2 の日に D07 の 3 イ・D08 の訪問診療時が立つ。管理料は立たない（確定した (Ⅰ)1 が 0。W-113）
    const noVisits = deriveLines({ ...input, events: K1.events.filter((e) => e.type !== "visit"), manual: [line("C001_2I", 1, [day(9)])] });
    expect(noVisits.unsupported.map((u) => u.code)).not.toContain("visit2_pending");
    const at9 = noVisits.basis.filter((b) => b.dates.includes(day(9))).map((b) => [b.derive, b.kubun]);
    expect(at9).toEqual(expect.arrayContaining([["D07", "O001_3I"], ["D08", "O100_1HA"]]));
    expect(noVisits.basis.filter((b) => b.derive === "D03")).toEqual([]);
  });
});

describe("導出 D02：(Ⅰ)2 の日の往診（round-82 C-532）", () => {
  it("同じ日の事情が分からなければ往診料を落とさず、R10 と同じ事実を保留で聞く。急変の往診と分かれば立てる", async () => {
    const { deriveLines } = await import("../../src/engine/derive");
    const K1 = loadCase("K1");
    const events = [{ type: "oushin" as const, date: day(12), kind: "normal" as const }];
    const input = { yearMonth: K1.yearMonth, facility: K1.facility, history: K1.history, choices: {}, events, manual: [line("C001_2I", 1, [day(12)])] };
    const unknown = deriveLines({ ...input, facts: { ...K1.facts, sameDaySeparate: { known: false }, sameDayOushinAfterVisit: { known: false } } });
    expect(unknown.pending.filter((p) => p.id === `D01-sameDay:${day(12)}`).length).toBe(1);
    expect(unknown.notBilled).toEqual([]);
    expect(unknown.lines.some((l) => l.kubun === "C000")).toBe(false);
    const after = deriveLines({ ...input, facts: { ...K1.facts, sameDaySeparate: { known: true, value: { [day(12)]: true } }, sameDayOushinAfterVisit: { known: true, value: { [day(12)]: true } } } });
    expect(after.lines.some((l) => l.kubun === "C000" && l.dates.includes(day(12)))).toBe(true);
  });
});
