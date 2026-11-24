// 版の区分を足す前と後の、合成の UKE の点検の結果の差（design.md §18-11。v37 21c）：C001_2I・C001_2RO・C007・C010 を版に入れると、
// 今まで「点検の対象外の単位」だった行が点検の行になり、partial の扱いと合計が変わる。足す前の版（4 区分と R20・R21 を除いたもの）と、今の版で同じ UKE を読み比べる。
// 訪問診療料(Ⅰ)2 の行がある請求では、(Ⅰ)2 と同じ区分番号を読む既存のルールを、足す前と同じ「決められない」に置く（design.md §18-12 の 8。当面の形）：
// 足す前と後で、既存のルールの確定の指摘が増えないことをここで縛る
import { describe, expect, it } from "vitest";
import { evaluateWith } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext, Outside } from "../../src/engine/types";
import { heldByVisit2 } from "../../src/engine/visit2";
import { UNKNOWN_FACTS } from "../../src/server/app/cases";
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

  it("申告のない請求では R20・R21 は何も言わない。ほかのルールの指摘は、(Ⅰ)2 の行で決められないに置いた R17 の T176（在医総管の月の訪問日の記載）が消えるほかは同じ", () => {
    expect(a.findings.filter((k) => k.startsWith("R20") || k.startsWith("R21"))).toEqual([]);
    expect({ added: a.findings.filter((k) => !b.findings.includes(k)), removed: b.findings.filter((k) => !a.findings.includes(k)) }).toEqual({ added: [], removed: ["R17.comment_missing"] });
    expect(a.unsupported).toContain("R17");
  });
});

describe("訪問診療料(Ⅰ)2 の行がある請求（design.md §18-12 の 8。当面の形。em-v38-draft.md §2）", () => {
  const K1 = loadCase("K1");
  const HELD = ["R08", "R09", "R10", "R15"];
  /** 確定の指摘のうち、決められないに置いたルール（と R17 の T176）のもの */
  const heldOf = (xs: string[]) => xs.filter((k) => HELD.some((id) => k.startsWith(`${id}.`)));

  it("決められないに置くのは R08・R09・R10・R15（と R17 の T176）だけ。R01・R02・R03・R13 などは今のまま", () => {
    expect(after.rules.filter((r) => heldByVisit2(r, after)).map((r) => r.id)).toEqual(HELD);
  });

  it("R01・R03 は足した後の判定が出る（区分の回数は (Ⅰ)1 だけで数える。留意 C002 (4)）。足す前は決められなかった", () => {
    const only2 = [{ kubun: "C001_2I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
    const mixed = [{ kubun: "C001_1I", count: 1, dates: [day(6)] }, { kubun: "C001_2I", count: 1, dates: [day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
    for (const masters of [false, true]) {
      const [b2, a2] = [judge(before, only2, K1.facts, masters), judge(after, only2, K1.facts, masters)];
      expect(b2.unsupported).toContain("R01");
      expect(a2.unsupported).not.toContain("R01");
      expect(a2.findings).toContain("R01.no_visit");
      const [b3, a3] = [judge(before, mixed, K1.facts, masters), judge(after, mixed, K1.facts, masters)];
      expect(b3.unsupported).toEqual(expect.arrayContaining(["R01", "R03"]));
      expect(a3.findings).toEqual(expect.arrayContaining(["R01.use_once", "R03.missing"]));
    }
  });

  it("決められないに置いたルールは、足す前と同じ：確定の指摘は増えず、(Ⅰ)2 の行がある請求では決められない（情報不足）", () => {
    // (Ⅰ)2 の日に訪問診療時のベースアップ評価料・物価対応料（資料では正しい。今の読みは (Ⅰ)2 の日を訪問診療の日に入れないので誤りと言い得る）と、同じ日の往診料
    const lines = [line("C001_1I", 1, [day(6)]), line("C001_2I", 1, [day(20)]), line("O001_3I", 2, [day(6), day(20)]), line("O100_1HA", 2, [day(6), day(20)]), line("C000", 1, [day(20)]), line("C002_2NI1", 1, [day(6)])];
    for (const masters of [false, true]) {
      const [b, a] = [judgeCtx(before, { ...base(K1.facts), lines }, masters), judgeCtx(after, { ...base(K1.facts), lines }, masters)];
      expect(heldOf(a.certain).filter((k) => !b.certain.includes(k)), `masters=${masters}`).toEqual([]);
      expect(heldOf(a.certain)).toEqual([]);
      for (const id of ["R08", "R15"]) expect([masters, id, b.unsupported.includes(id), a.unsupported.includes(id)]).toEqual([masters, id, true, true]);
    }
  });

  it("同梱の症例 K1〜K7 に (Ⅰ)2 の行を足しても、決められないに置いたルールの確定の指摘は足す前より増えない。R17 の T176 は決められない", () => {
    for (const n of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) {
      const c = loadCase(n);
      const first = c.lines.find((l) => l.kubun === "C001_1I" || l.kubun === "C001_1RO")?.dates[0] ?? day(6);
      for (const masters of [false, true]) {
        // 足す前：(Ⅰ)2 の行は対象外の単位（行に入らない）。足した後：行に入る
        const ctx = { ...c, claimId: "X", events: [], recordsKnown: false };
        const pre: ClaimContext = { ...ctx, partial: true, ...(masters ? { outside: outsideOf(["114042110"]) } : {}) };
        const certain = (rev: Revision, x: ClaimContext) => evaluateWith(x, rev).findings.filter((f) => f.kind !== "情報不足" && f.params?.conditional !== "1").map((f) => `${f.messageKey}:${f.params?.rule ?? ""}:${f.lineRefs.join(",")}`);
        const post = withLines(ctx, line("C001_2I", 1, [first]));
        const [bb, aa] = [certain(before, pre), certain(after, post)];
        const t176 = (xs: string[]) => xs.filter((k) => k.startsWith("R17.") && k.includes(":T176-date:"));
        expect([n, masters, heldOf(aa).filter((k) => !bb.includes(k)), t176(aa)]).toEqual([n, masters, [], []]);
      }
    }
  });
});

describe("導出（算定プレビュー）で (Ⅰ)2 の行が入力にある月（design.md §18-12 の 8。当面の形）", () => {
  it("D01・D02・D06・D07・D08・D12 は行にせず「決められない」（visit2_pending）。D03（管理料）は今のまま立つ", async () => {
    const { deriveLines } = await import("../../src/engine/derive");
    const K1 = loadCase("K1");
    const input = { yearMonth: K1.yearMonth, facility: K1.facility, facts: K1.facts, events: K1.events, history: K1.history, choices: {} };
    const plain = deriveLines({ ...input, manual: [] });
    const held = deriveLines({ ...input, manual: [line("C001_2I", 1, [day(9)])] });
    expect(plain.basis.some((b) => b.derive === "D01")).toBe(true);
    expect(held.basis.filter((b) => ["D01", "D02", "D06", "D07", "D08", "D12"].includes(b.derive))).toEqual([]);
    expect(held.unsupported.map((u) => u.code)).toContain("visit2_pending");
    expect(held.basis.filter((b) => b.derive === "D03").map((b) => b.kubun)).toEqual(plain.basis.filter((b) => b.derive === "D03").map((b) => b.kubun));
  });
});
