// 版の区分を足す前と後の、合成の UKE の点検の結果の差（design.md §18-11。v37 21c）：C001_2I・C001_2RO・C007・C010 を版に入れると、
// 今まで「点検の対象外の単位」だった行が点検の行になり、partial の扱いと合計が変わる。足す前の版（4 区分と R20・R21 を除いたもの）と、今の版で同じ UKE を読み比べる
import { describe, expect, it } from "vitest";
import { evaluateWith } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext } from "../../src/engine/types";
import { UNKNOWN_FACTS } from "../../src/server/app/cases";
import { mapClaim, parseUke, writeUke } from "../../src/uke/uke";
import { fileOf, receiptOf } from "../helpers/care";
import { loadCase } from "./helpers";
import { day, YM } from "../helpers/period";

const ADDED = ["C001_2I", "C001_2RO", "C007", "C010"];
const after = resolveRevision(YM);
const omit = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => !ADDED.includes(k)));
/** 足す前の版：4 区分の点数・コード・診療識別と、R20・R21・その定数を除く */
const before: Revision = { ...after, points: omit(after.points), codes: omit(after.codes), shikibetsu: omit(after.shikibetsu), consts: { ...after.consts, visit2Kubun: undefined, care: undefined }, rules: after.rules.filter((r) => r.id !== "R20" && r.id !== "R21") };

/** 合成の UKE（K1 の施設の設定と、分からない事実）を、版 rev で読んで判定する */
function judge(rev: Revision, lines: ClaimContext["lines"], facts = UNKNOWN_FACTS) {
  const claim = parseUke(writeUke(fileOf([receiptOf(1, YM, lines)]))).claims[0];
  const m = mapClaim(claim, rev);
  const ctx: ClaimContext = { claimId: "X", yearMonth: YM, facility: loadCase("K1").facility, payer: "支払基金", prefecture: "東京都", facts, events: [], recordsKnown: false, lines: m.lines, comments: m.comments, commentsKnown: true, ...(m.others.length ? { partial: true } : {}) };
  const r = evaluateWith(ctx, rev);
  return { lines: m.lines.map((l) => l.kubun), others: m.others.flatMap((o) => o.codes), total: r.total, subtotal: r.subtotal, unsupported: r.findings.filter((f) => f.missing?.field === "unsupportedLines").map((f) => f.ruleId), findings: r.findings.filter((f) => f.kind !== "情報不足").map((f) => f.messageKey) };
}

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

  it("足す前は対象外の単位のために決められなかったルールがあり（基本マスターなしでは全部のルールが partial）、足した後は決められないことの情報不足が消える", () => {
    expect(b.unsupported.length).toBeGreaterThanOrEqual(0);
    expect(a.unsupported).toEqual([]);
  });

  it("指摘の差：申告のない請求では R20・R21 は何も言わない。ほかのルールの指摘の差は、ここに並べたものだけ", () => {
    expect(a.findings.filter((k) => k.startsWith("R20") || k.startsWith("R21"))).toEqual([]);
    const added = a.findings.filter((k) => !b.findings.includes(k));
    const removed = b.findings.filter((k) => !a.findings.includes(k));
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });
  // 設計の穴（最終報告に書く）：R01〜R19 の訪問診療料の数え方（visitKubun）に (Ⅰ)2 を入れるかは決めていない。足す前は (Ⅰ)2 の行が対象外の単位で R01・R03 が partial（決められない）だったが、
  // 足した後は (Ⅰ)2 を数えずに判定するので、(Ⅰ)2 だけの月は R01.no_visit、(Ⅰ)1 と (Ⅰ)2 が 1 回ずつの月は R01.use_once と R03.missing が確定で出る。その差をここに並べる
  it("訪問診療料(Ⅰ)2 の行がある請求：足す前は R01・R03 が決められない。足した後は (Ⅰ)2 を数えずに判定し、ここに並べた指摘が増える", () => {
    const K1 = loadCase("K1");
    const only2 = [{ kubun: "C001_2I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
    const [b2, a2] = [judge(before, only2, K1.facts), judge(after, only2, K1.facts)];
    expect([b2.unsupported, a2.unsupported]).toEqual([["R01"], []]);
    expect(a2.findings.filter((k) => !b2.findings.includes(k))).toEqual(["R01.no_visit", "R21.visit2_count"]);
    const mixed = [{ kubun: "C001_1I", count: 1, dates: [day(6)] }, { kubun: "C001_2I", count: 1, dates: [day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
    const [b3, a3] = [judge(before, mixed, K1.facts), judge(after, mixed, K1.facts)];
    expect([b3.unsupported, a3.unsupported]).toEqual([["R01", "R03"], []]);
    expect(a3.findings.filter((k) => !b3.findings.includes(k))).toEqual(["R01.use_once", "R03.missing"]);
    // 合計：足す前は出ない（小計だけ）、足した後は出る
    expect([b3.total, typeof a3.total]).toEqual([null, "number"]);
  });
});
