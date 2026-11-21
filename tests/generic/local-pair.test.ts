// 段 16：背反の組の院内の知識を、G05 で使う（design.md §14-3・§14-5）。小さな表（tests/generic/small-tensuhyo.ts）と、テスト用に作った例外の決まり（EM の行ではない）で確かめる
import { describe, expect, it } from "vitest";
import { evaluateGeneric } from "../../src/generic";
import { makeG05 } from "../../src/generic/g05";
import { HAIHAN, haihanKey, type HaihanConfig } from "../../src/generic/haihan";
import { localKey, pairOf, type LocalPairKnowledge } from "../../src/generic/local-pair";
import { genericScopeOf } from "../../src/generic/scope";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import type { GenericAboutMore } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import type { CodePair } from "../../src/lifecycle/types";
import { genericText } from "../../src/messages";
import { YM } from "../helpers/period";
import { GEN } from "./small-masters";
import { C, tensuhyoMasters } from "./small-tensuhyo";

type Unit = TimedClaim["units"][number];
const unit = (codes: string[], days: number[]): Unit => {
  const d = Array.from({ length: 31 }, () => 0);
  for (const n of days) d[n - 1]++;
  return { items: codes.map((code) => ({ kind: "SI" as const, code })), count: days.length, days: d };
};
const day = (n: number) => `${YM}-${String(n).padStart(2, "0")}`;
/** どの組（HP）もない決まり：特例条件の行は全部 (i) になる */
const NO_HP: HaihanConfig = { patterns: [], exceptions: [] };
/** 往診料×訪問診療料に、ウ（kind=none）の例外だけを持つ組：いつも「決まらない」(ii) */
const UNDECIDED: HaihanConfig = {
  patterns: [{ id: "HP-T1", a: { codes: [C.oushin] }, b: { codes: [C.houmon] }, tani: [1], exceptions: ["HX-T1"] }],
  exceptions: [{ id: "HX-T1", text: "テスト用の例外（原文で確かめられない）", kind: "none" }],
};
const SINCE = "2026-10-01T09:00:00+09:00";
const K = (over: Partial<LocalPairKnowledge> = {}): LocalPairKnowledge => ({ id: "local/pair-a", status: "承認済み", polarity: "allow", conditionNote: "根拠：審査で通った。テストの条件", rev: "aaaaaaaaaaaa", since: SINCE, ...over });
const OU_HO: CodePair = pairOf(C.oushin, C.houmon, 1);
const run = (units: Unit[], about: Partial<GenericAboutMore>, config: HaihanConfig = NO_HP) => {
  const db = tensuhyoMasters();
  const claim = { units };
  const a = { yearMonth: YM, generation: GEN, ...about };
  const r = evaluateGeneric(claim, db, a, [makeG05(config)], new Set());
  const view = genericView(r, null);
  return { findings: r.findings.filter((f) => f.check === "G05"), view: view.findings.filter((f) => f.check === "G05"), result: r, scope: genericScopeOf(claim, db, a, r) };
};
const know = (list: LocalPairKnowledge[], want: CodePair = OU_HO) => (p: CodePair) => (p.a === want.a && p.b === want.b && p.tani === want.tani ? list : []);
/** 往診料と訪問診療料が 6 日・9 日に両方ある請求 */
const twoDays = [unit([C.oushin], [6, 9]), unit([C.houmon], [6, 9])];
/** 押した事実：key と日付 → 押した時刻（押したときの知識の status_since は since） */
const pressed = (m: Record<string, string>, since = SINCE) => (key: string, date: string | null) => (m[`${key}|${date ?? ""}`] ? { at: m[`${key}|${date ?? ""}`], since } : null);
const KEY = localKey("local/pair-a", "aaaaaaaaaaaa", C.oushin, C.houmon);
const LATER = "2026-10-05T09:00:00+09:00";

describe("Lv.5 の本人・承認済みの allow（design.md §14-5）", () => {
  it("条件とボタン（押していない日ごと）を添える。USED の対象になる", () => {
    const r = run(twoDays, { localKnowledge: know([K()]), level: 5, pressed: pressed({}) });
    expect(r.view.map((f) => [f.local?.mode, f.local?.texts, f.local?.press])).toEqual([["allow", ["院内の知識（承認済み）：条件に当たれば併せて算定できます。条件：根拠：審査で通った。テストの条件"], [{ key: KEY, date: day(6) }, { key: KEY, date: day(9) }]]]);
    expect(r.result.localUsed).toEqual(["local/pair-a"]);
  });
  it("押した日だけ出なくなり、点検の範囲に数と id。押さない日は出る。押さない請求（押した事実なし）は両方の日が出る", () => {
    const r = run(twoDays, { localKnowledge: know([K()]), level: 5, pressed: pressed({ [`${KEY}|${day(6)}`]: LATER }) });
    expect(r.findings.map((f) => [f.messageKey, f.params.days])).toEqual([["G05.day_cond", "9"]]);
    expect(r.view[0].local?.press).toEqual([{ key: KEY, date: day(9) }]);
    expect(r.scope.notDone).toContain("院内の知識で、この請求も条件に当たると確かめたので出していない：1 件（local/pair-a）");
    const both = run(twoDays, { localKnowledge: know([K()]), level: 5, pressed: pressed({ [`${KEY}|${day(6)}`]: LATER, [`${KEY}|${day(9)}`]: LATER }) });
    expect([both.findings, both.result.localSilenced]).toEqual([[], [{ id: "local/pair-a", count: 2 }]]);
  });
  it("知識の rev が変わる・承認済みに入り直した（status_since が押した時刻より後。時計が進まず同じ時刻でも）と、前の押下は効かない（C-171・C-180）", () => {
    const p = pressed({ [`${KEY}|${day(6)}`]: LATER, [`${KEY}|${day(9)}`]: LATER });
    expect(run(twoDays, { localKnowledge: know([K({ rev: "bbbbbbbbbbbb" })]), level: 5, pressed: p }).findings.length).toBe(1);
    expect(run(twoDays, { localKnowledge: know([K({ since: "2026-10-06T09:00:00+09:00" })]), level: 5, pressed: p }).findings.length).toBe(1);
    // デモの時計（進まない）：押したのと同じ時刻に、要再検証から承認済みに戻った → 押したときの status_since が違うので効かない
    expect(run(twoDays, { localKnowledge: know([K({ since: LATER })]), level: 5, pressed: p }).findings.length).toBe(1);
    // 承認と同じ時刻に押した（承認済みの間）→ 効く
    expect(run(twoDays, { localKnowledge: know([K()]), level: 5, pressed: pressed({ [`${KEY}|${day(6)}`]: SINCE, [`${KEY}|${day(9)}`]: SINCE }) }).findings).toEqual([]);
  });
  it("同一月の表（tani 2）は請求ごとに押す（日付なし）。同時の表（tani 3）は算定日ごと", () => {
    const month: CodePair = pairOf(C.sanso, C.sansoKyunyu, 2);
    const units = [unit([C.sanso], [3]), unit([C.sansoKyunyu], [20])];
    const r = run(units, { localKnowledge: know([K()], month), level: 6, pressed: pressed({}) });
    expect(r.view.map((f) => f.local?.press)).toEqual([[{ key: localKey("local/pair-a", "aaaaaaaaaaaa", C.sanso, C.sansoKyunyu), date: null }]]);
    expect(run(units, { localKnowledge: know([K()], month), level: 6, pressed: pressed({ [`${localKey("local/pair-a", "aaaaaaaaaaaa", C.sanso, C.sansoKyunyu)}|`]: LATER }) }).findings).toEqual([]);
    const same: CodePair = pairOf(C.oushin, C.kyukyu, 3);
    const t3 = run([unit([C.oushin, C.kyukyu], [4])], { localKnowledge: know([K()], same), level: 5, pressed: pressed({}) });
    expect(t3.view.map((f) => f.local?.press)).toEqual([[{ key: localKey("local/pair-a", "aaaaaaaaaaaa", C.oushin, C.kyukyu), date: day(4) }]]);
  });
});

describe("Lv.4 の本人：ヒントとして条件を添え、ボタンは出さない", () => {
  it("allow も avoid も「確かめてください」の指摘のまま、ヒントを添える。押した事実があっても消さない。USED の対象", () => {
    for (const polarity of ["allow", "avoid"] as const) {
      const r = run(twoDays, { localKnowledge: know([K({ polarity })]), level: 4, pressed: pressed({ [`${KEY}|${day(6)}`]: LATER }) });
      expect(r.findings.map((f) => [f.messageKey, f.params.days])).toEqual([["G05.day_cond", "6・9"]]);
      expect([r.view[0].local?.mode, r.view[0].local?.press, r.result.localUsed]).toEqual(["hint", [], ["local/pair-a"]]);
      expect(r.view[0].local?.texts[0]).toContain(polarity === "allow" ? "条件に当たれば併せて算定できます" : "併せて算定できません");
    }
  });
});

describe("承認済みの avoid・判断の軸にしない状態・食い違い", () => {
  it("Lv.5 の avoid → G05.local_avoid（条件つき）", () => {
    const r = run(twoDays, { localKnowledge: know([K({ polarity: "avoid", conditionNote: "根拠：返戻・査定された。テスト" })]), level: 5 });
    expect(r.findings.map((f) => [f.messageKey, f.certainty])).toEqual([["G05.local_avoid", "条件つき"]]);
    expect(genericText(r.findings[0])).toContain("院内の知識（承認済み）で、併せて算定できない組です（同じ日（6・9日）");
    expect(genericText(r.findings[0])).toContain("根拠：返戻・査定された。テスト（local/pair-a）");
  });
  it("未検証・contested・要再検証・停止は使わない（未検証だけ id を添える）。USED にもならない", () => {
    for (const status of ["contested", "要再検証", "停止"] as const) {
      const r = run(twoDays, { localKnowledge: know([K({ status })]), level: 9 });
      expect([r.findings.map((f) => f.messageKey), r.view[0].local, r.result.localUsed]).toEqual([["G05.day_cond"], undefined, undefined]);
    }
    const u = run(twoDays, { localKnowledge: know([K({ status: "未検証" })]), level: 9 });
    expect([u.view[0].local?.mode, u.view[0].local?.texts, u.result.localUsed]).toEqual(["unverified", ["前回の確かめ（未検証）があります：local/pair-a"], undefined]);
  });
  it("承認済みに allow と avoid が両方ある → 使わない（食い違っていると添える）", () => {
    const r = run(twoDays, { localKnowledge: know([K(), K({ id: "local/pair-b", polarity: "avoid" })]), level: 9, pressed: pressed({ [`${KEY}|${day(6)}`]: LATER }) });
    expect([r.findings.map((f) => [f.messageKey, f.params.days]), r.view[0].local?.mode, r.result.localUsed]).toEqual([[["G05.day_cond", "6・9"]], "conflict", undefined]);
  });
});

describe("対象：§13 で決まらないものだけ（design.md §14-3）", () => {
  it("(ii) ウの例外だけの組（決まらない）にも添える（X-123）。残った日の文は exception_check のまま", () => {
    const r = run(twoDays, { localKnowledge: know([K()]), level: 5, pressed: pressed({ [`${KEY}|${day(9)}`]: LATER }), answers: () => null, facts: undefined }, UNDECIDED);
    expect(r.findings.map((f) => [f.messageKey, f.params.days])).toEqual([["G05.exception_check", "6"]]);
  });
  it("§13 の問いが未決の組、§13 で決まった組には効かない（出荷の決まり HP-01）", () => {
    const facts = (separate?: Record<string, boolean>) => ({ sameDaySeparate: separate ? { known: true, value: separate } : { known: false }, sameDayOushinAfterVisit: { known: false }, deathPlace: { known: false } }) as unknown as GenericAboutMore["facts"];
    const base = { localKnowledge: know([K()]), level: 9, pressed: pressed({ [`${KEY}|${day(6)}`]: LATER, [`${KEY}|${day(9)}`]: LATER }) };
    // 問いが未決（答えなし）→ 問いのまま
    const open = run(twoDays, { ...base, answers: () => null, facts: facts() }, HAIHAN);
    expect([open.findings.map((f) => f.messageKey), open.view[0].local, open.result.localUsed]).toEqual([["G05.exception_ask"], undefined, undefined]);
    // 答えを渡さない点検（月末の点検）で問いがある → 問いの文のまま
    expect(run(twoDays, base, HAIHAN).view.map((f) => [f.text.includes("医療事務に確かめること"), f.local])).toEqual([[true, undefined]]);
    // 決まった（当たらない）→ exception_none のまま
    const none = run(twoDays, { ...base, answers: () => null, facts: facts({ [day(6)]: false, [day(9)]: false }) }, HAIHAN);
    expect([none.findings.map((f) => [f.messageKey, f.params.local]), none.result.localUsed]).toEqual([[["G05.exception_none", undefined]], undefined]);
    // 答えの key は §13 の haihan:* のまま
    expect(haihanKey("HX-01", C.oushin, C.houmon)).toMatch(/^haihan:/);
  });
  it("特例条件のない行（言い切りの候補）・1 週間の表には添えない。知識を渡さない点検（measure-generic）は今までどおり", () => {
    const db = run([unit([C.saishin], [3]), unit([C.houmon], [3])], { localKnowledge: () => [K()], level: 9 });
    expect([db.findings.map((f) => f.messageKey), db.view[0].local]).toEqual([["G05.day"], undefined]);
    const week = run([unit([C.shoshin], [3]), unit([C.gairaiReha], [5])], { localKnowledge: () => [K()], level: 9 });
    expect([week.findings.map((f) => f.messageKey), week.view[0].local]).toEqual([["G05.week_cond"], undefined]);
    const plain = run(twoDays, {});
    expect([plain.findings.map((f) => [f.messageKey, f.params.local]), plain.result.localUsed]).toEqual([[["G05.day_cond", undefined]], undefined]);
  });
});
