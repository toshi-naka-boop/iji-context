// 段 17i：注14 の計算の道具の 1 段目（design.md §15-13）。取り込んだ UKE から月ごとに数える回数と、回数の門の判定（U-27・U-30 の両方の読み）
import { describe, expect, it } from "vitest";
import { hasRevision, resolveRevision } from "../../src/engine/revisions";
import { AUTO_TEXT, countMonths } from "../../src/note14/count";
import { evaluate, monthsBefore, periodOf, toolConstsOf, type Stage1Input } from "../../src/note14/evaluate";
import { parseUke } from "../../src/uke/uke";
import { fieldKeys } from "../../src/note14/readings";
import { dateIn, month } from "../helpers/period";
import { baseFile, receipt, ukeBytes } from "./uke";

const M = month(1);
const K = toolConstsOf(resolveRevision(M).consts.note14)!;
const [m1, m2, m3] = monthsBefore(M, K.periodMonths.short);
const kouCodes = K.countRows.filter((r) => r.reading === "both").map((r) => r.code);
const otsuCodes = K.countRows.filter((r) => r.reading === "otsu").map((r) => r.code);
const rowsOf = (m: string) => (hasRevision(m) ? (toolConstsOf(resolveRevision(m).consts.note14)?.countRows ?? null) : null);

describe("取り込んだ UKE から月ごとに数える（EM §2-8 の数える行の別表だけ。W-4）", () => {
  // 3 か月分：甲の行（C001_1I・C001_1RO）と、同じ区分番号の鍵に並ぶ加算の行（看取り加算・死亡診断加算・DX 加算）と、乙だけの行（C001-2 のイ）を混ぜる
  const file = {
    ...baseFile(),
    receipts: [
      receipt(m1, [{ kubun: "C001_1I", count: 2, dates: [dateIn(-2, 5), dateIn(-2, 19)] }, { kubun: "C001_N13_DX", count: 1, dates: [dateIn(-2, 5)] }]),
      receipt(m1, [{ kubun: "C001_1RO", count: 3, dates: [dateIn(-2, 6), dateIn(-2, 13), dateIn(-2, 20)] }]),
      receipt(m2, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-1, 7)] }, { kubun: "C001_N7_MITORI", count: 1, dates: [dateIn(-1, 7)] }, { kubun: "C001_N8_SHIBOU", count: 1, dates: [dateIn(-1, 7)] }]),
      receipt(m3, [{ kubun: "C001_1I", count: 2, dates: [dateIn(0, 3), dateIn(0, 17)] }]),
    ],
  };
  // m3 の 1 枚目に乙だけの行を 2 日
  const claims = parseUke(ukeBytes(file, { 3: [{ code: otsuCodes[0], points: 152, days: [4, 18] }] })).claims;
  it("月ごとの甲・乙の回数が、別表の行の回数の合計と一致し、加算の行は数えない", () => {
    const got = countMonths(claims, [m1, m2, m3], rowsOf);
    expect(got).toEqual([
      { month: m1, state: "ok", receipts: 2, kou: 5, otsuExtra: 0 },
      { month: m2, state: "ok", receipts: 1, kou: 1, otsuExtra: 0 },
      { month: m3, state: "ok", receipts: 1, kou: 2, otsuExtra: 2 },
    ]);
    // 甲の行のコードは別表の「甲・乙」の行
    expect(kouCodes).toContain(resolveRevision(m1).codes.C001_1I.primary);
  });
  it("取り込みのない月は none、同じ月のレセプトの鍵が 2 つ以上のレセプトで重なる月は overlap（自動で数えない）", () => {
    const twin = { name: "架空 重子", birth: "19400101", sex: 2 as const };
    const f2 = { ...baseFile(), receipts: [receipt(m1, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-2, 5)] }], twin), receipt(m1, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-2, 12)] }], twin)] };
    const got = countMonths(parseUke(ukeBytes(f2)).claims, [m1, m2], rowsOf);
    expect(got.map((g) => g.state)).toEqual(["overlap", "none"]);
    // 種別の違う 2 枚は重なりではない
    const f3 = { ...baseFile(), receipts: [receipt(m1, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-2, 5)] }], { ...twin, receiptType: "1112" }), receipt(m1, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-2, 12)] }], { ...twin, receiptType: "1318" })] };
    expect(countMonths(parseUke(ukeBytes(f3)).claims, [m1], rowsOf)[0].state).toBe("ok");
  });
  it("X-201：読めない請求（未対応のレコードつき）がある月は 0 回と数えず、unreadable（取り込み直すか手入力に案内）にする", () => {
    const f = { ...baseFile(), receipts: [receipt(m1, [{ kubun: "C001_1I", count: 10, dates: Array.from({ length: 10 }, (_, i) => dateIn(-2, i + 1)) }]), receipt(m1, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-2, 5)] }]), receipt(m2, [{ kubun: "C001_1I", count: 1, dates: [dateIn(-1, 5)] }])] };
    const parsed = parseUke(ukeBytes(f, {}, { 0: ["ZZ,x"] })).claims;
    expect(parsed[0].unsupported).toBeDefined();
    const got = countMonths(parsed, [m1, m2], rowsOf);
    expect(got[0]).toEqual({ month: m1, state: "unreadable", receipts: 2, unreadable: 1 });
    expect(got[1]).toEqual({ month: m2, state: "ok", receipts: 1, kou: 1, otsuExtra: 0 });
    expect(AUTO_TEXT.unreadable).toContain("読めない請求");
    // 行が 1 つも読めていない請求（units が空）も同じ
    expect(countMonths([{ ...parsed[2], units: [] }], [m2], rowsOf)[0].state).toBe("unreadable");
  });
  it("C-326：その月の版に別表がない月（令和8年度改定より前など）は自動で数えない", () => {
    const early = month(-5);
    expect(rowsOf(early)).toBeNull();
    expect(countMonths(claims, [early], rowsOf)[0].state).toBe("no_table");
  });
});

const auto = (kou: number, otsuExtra = 0) => [m1, m2, m3].map((month, i) => ({ month, kou: i === 0 ? kou : 0, otsuExtra: i === 0 ? otsuExtra : 0, source: "auto" as const }));
const s1 = (over: Partial<Stage1Input> = {}): Stage1Input => ({ months: auto(0), gansou: 0, secondPatient: 0, special: "none", institutions: [], ...over });
const T = K.visitThreshold;
/** 2 段目の 4 つの要件のうち紹介を満たさない入力（2 段目に進む読みは減算になる） */
const notMet = { values: Object.fromEntries(fieldKeys().map((f) => [f.key, f.field.id === "mitoriHome" ? K.mitoriMin : f.field.id === "referral" ? 0 : 1])), openedOn: null };

describe("回数の門の判定（EM R8-194・R8-195。U-27・U-30a・U-30b）", () => {
  it("甲・乙のどちらでも門未満 → 基準に当たる。あと n 回は読みのうち小さいほう", () => {
    const e = evaluate({ stage1: s1({ months: auto(T - 100, 40), gansou: 10 }) }, K);
    expect(e.status === "done" && [e.result, e.remaining, e.splits]).toEqual(["meets", 50, []]);
  });
  it("どちらでも門以上 → 2 段目へ（1 段目だけでは言い切らない）", () => {
    const e = evaluate({ stage1: s1({ months: auto(T) }) }, K);
    expect(e.stage2Open).toBe(true);
  });
  it("割れる入力（甲は門未満・乙は門以上で 2 段目を満たさない）→ 決めきれないと U-27 の 1 行（照会の番号つき）", () => {
    expect(evaluate({ stage1: s1({ months: auto(T - 1, 1) }) }, K).stage2Open).toBe(true);
    const e = evaluate({ stage1: s1({ months: auto(T - 1, 1) }), stage2: notMet }, K);
    expect(e.status === "done" && [e.result, e.splits, e.lines]).toEqual(["undecided", ["U-27"], ["U-27〔回数に入れる区分〕：C001 の行だけなら減算にならず、C001-2 などを入れると減算になります。厚生局に確かめてください（照会 #1）"]]);
  });
  it("特別の関係の機関が「分からない」→ 決めきれない（自院だけで門以上なら 2 段目へ）", () => {
    const e = evaluate({ stage1: s1({ months: auto(T - 1), special: "unknown" }) }, K);
    expect(e.status === "done" && [e.result, e.reasons]).toEqual(["undecided", ["特別の関係の機関が分からない"]]);
  });
  it("開設日が境の日の機関を入れると U-30a で割れる（除くなら門未満・足すなら門以上で 2 段目へ）。開設者の変更があると U-30b で割れる", () => {
    const cut = K.excludeOpenedOnOrBefore;
    const inst = (openedOn: string, ownerChangedFrom: string | null = null) => ({ stage1: s1({ months: auto(T - 200), special: "some", institutions: [{ openedOn, ownerChangedFrom, count: 200 }] }) });
    expect(evaluate(inst(cut), K).stage2Open).toBe(true);
    const e = evaluate({ ...inst(cut), stage2: notMet }, K);
    expect(e.status === "done" && [e.result, e.splits]).toEqual(["undecided", ["U-30a"]]);
    expect(e.status === "done" && e.lines[0]).toBe("U-30a〔3 月 31 日に開設した機関〕：告示・通知の読み（除く）なら減算にならず、様式の読み（足す）だと減算になります。厚生局に確かめてください（照会 #5）");
    // 境の日の機関の回数を足しても門未満なら割れない
    const small = evaluate({ stage1: s1({ months: auto(T - 300), special: "some", institutions: [{ openedOn: cut, ownerChangedFrom: null, count: 100 }] }) }, K);
    expect(small.status === "done" && [small.result, small.splits]).toEqual(["meets", []]);
    // 境の日より前に開設した機関はどの読みでも足さない（開設者の変更がなければ割れない）
    const before = evaluate(inst(`${Number(cut.slice(0, 4)) - 1}${cut.slice(4)}`), K);
    expect(before.status === "done" && [before.result, before.splits]).toEqual(["meets", []]);
    // 開設者を変えた機関：新しい開設の日は境より後、元の開設の日は境より前 → U-30b で割れ、2 段目が開く
    const changed = evaluate({ ...inst(`${M}-01`, `${Number(cut.slice(0, 4)) - 1}${cut.slice(4)}`), stage2: notMet }, K);
    expect(changed.status === "done" && [changed.result, changed.splits]).toEqual(["undecided", ["U-30b"]]);
  });
  it("C-323：読み乙だけの手入力の欄が空で、甲・乙の自動の数が門未満 → 決めきれない（手入力の欄が空：〔欄の名前〕）。「0（ない）」で言い切る", () => {
    const e = evaluate({ stage1: s1({ months: auto(T - 100, 10), gansou: null, secondPatient: null }) }, K);
    expect(e.status === "done" && e.result).toBe("undecided");
    expect(e.status === "done" && e.reasons[0]).toBe("手入力の欄が空：在宅がん医療総合診療料で訪問した日の回数・同一の患家の 2 人目以降で初診料・再診料を算定した日の回数");
    expect(e.status === "done" && e.lines).toEqual(["U-27〔回数に入れる区分〕：C001 の行だけなら減算にならず、C001-2 などを入れると分かりません。厚生局に確かめてください（照会 #1）"]);
    const z = evaluate({ stage1: s1({ months: auto(T - 100, 10), gansou: 0, secondPatient: 0 }) }, K);
    expect(z.status === "done" && z.result).toBe("meets");
  });
  it("C-334：甲の自動の数が門以上で、読み乙だけの欄が空 → 乙も門以上と決まり、2 段目へ（決めきれないにならない）", () => {
    const e = evaluate({ stage1: s1({ months: auto(T), gansou: null, secondPatient: null }) }, K);
    expect(e.stage2Open).toBe(true);
    expect(e.status === "incomplete" && e.missing.some((m) => m.includes("手入力"))).toBe(false);
  });
  it("取り込みのない月・確かめていない月は手入力で、空なら結果を出さず名指しする", () => {
    const e = evaluate({ stage1: s1({ months: [{ month: m1, kou: null, otsuExtra: null, source: "manual" }, ...auto(0).slice(1)] }) }, K);
    expect(e.status === "incomplete" && e.missing).toEqual([`${m1} の回数（C001 の行）`, `${m1} の回数（C001-2 の行）`]);
  });
  it("C-325：使った期間は確認月 M に対して M-3〜M-1 と M-12〜M-1", () => {
    expect(periodOf(M, K)).toEqual({ short: { from: month(-2), to: month(0) }, long: { from: month(-11), to: month(0) } });
  });
});
