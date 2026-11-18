// design.md §7 #16：算定行の導出（§2-8 の不変条件 1〜6、症例との一致、同じ日の訪問診療と往診、保留・未対応・見込み）
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventsFromNotes } from "../../src/chart/notes";
import { evaluate } from "../../src/engine";
import { derivedKubun, deriveLines, manualLinesOf, type DeriveInput, type DeriveResult } from "../../src/engine/derive";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext, ClaimEvent, ClaimLine, Facility, Finding } from "../../src/engine/types";
import { contextAsOf, deferAtMidMonth } from "../../src/visit/as-of";
import { day, YM } from "../helpers/period";
import { line, loadCase, withEvents, withFact } from "./helpers";

const REV = resolveRevision(YM);
const C = REV.consts;
const unknown = { known: false } as const;
const yes = { known: true, value: true } as const;
const no = { known: true, value: false } as const;

/** 症例の出来事・事実・施設の設定・manual（導出しない区分の行）・choices から導出する */
function derive(c: ClaimContext, over: Partial<DeriveInput> = {}): DeriveResult {
  const choices = (c as ClaimContext & { choices?: Record<string, string> }).choices ?? {};
  return deriveLines({ yearMonth: c.yearMonth, facility: c.facility, facts: c.facts, events: c.events, history: c.history, manual: manualLinesOf(c.lines, REV), choices, ...over });
}
/** 導出した行を検証に通す */
const judge = (c: ClaimContext, r: DeriveResult) => evaluate({ ...c, lines: r.lines });
const sorted = (lines: ClaimLine[]) => [...lines].map((l) => ({ ...l, dates: [...l.dates].sort() })).sort((a, b) => (a.kubun < b.kubun ? -1 : 1));
const kubunOf = (r: DeriveResult) => r.lines.map((l) => l.kubun);
const datesOf = (r: DeriveResult, kubun: string) => r.lines.find((l) => l.kubun === kubun)?.dates ?? [];
const wrongOrMissed = (fs: Finding[]) => fs.filter((f) => f.kind === "区分誤り" || f.kind === "取り忘れ");
const withFacility = (c: ClaimContext, over: Partial<Facility>): ClaimContext => ({ ...c, facility: { ...c.facility, ...over } });
const sep = (v: Record<string, boolean>) => ({ known: true, value: v }) as const;

const K1 = loadCase("K1");
const K2 = loadCase("K2");
const K4 = loadCase("K4");
const K5 = loadCase("K5");
/** K4 は要介護度が未入力の症例。要介護 2 を入れた形 */
const K4_CARE2 = withFact(K4, "careLevel", { known: true, value: 2 });

/** evidence-master §5-2 の合計（2026年10月診療分） */
const EM_TOTALS: [string, number][] = [
  ["K1", 14806],
  ["K2", 6372],
  ["K3", 16260],
  ["K4", 4540],
  ["K7", 4972],
];

describe("症例との一致（K1〜K4・K7）", () => {
  it.each(EM_TOTALS)("%s：導出した行が症例の行と一致し、検証に通すと指摘がなく、合計が %i 点", (name, total) => {
    const c = name === "K4" ? K4_CARE2 : loadCase(name);
    const r = derive(c);
    expect(r.pending).toEqual([]);
    expect(r.unsupported).toEqual([]);
    expect(r.totalStatus).toBe("ok");
    expect(sorted(r.lines)).toEqual(sorted(c.lines));
    const e = judge(c, r);
    expect(e.findings).toEqual([]);
    expect(e.total).toBe(total);
  });
  it("K4 は要介護度が未入力なので、包括的支援加算が保留（事実不足・宛先は医療事務）になり、合計を出さない", () => {
    const r = derive(K4);
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "careLevel", target: "clerk", blocks: [C.hokatsu.kubun] })]);
    expect(r.totalStatus).toBe("withheld");
    // 管理料までは立っていて、検証でも区分誤り・取り忘れは出ない（R03 は情報不足）
    expect(kubunOf(r)).toContain("C002-2_2RO1");
    expect(wrongOrMissed(judge(K4, r).findings)).toEqual([]);
  });
  describe("包括的支援加算（D04）：別表第八の三の場合分けで、導出と検証（R03）が同じ答えになる", () => {
    const care = (n: number) => ({ known: true, value: n }) as const;
    const of3 = (careLevel: ClaimContext["facts"]["careLevel"], other: ClaimContext["facts"]["table8_3Other"]) => withFact(withFact(K4, "careLevel", careLevel), "table8_3Other", other);
    const r03 = (c: ClaimContext) => judge(c, derive(c)).findings.filter((f) => f.ruleId === "R03");
    it.each([
      ["要介護 3・ほかは不明", of3(care(3), unknown)],
      ["要介護 2・ほかの状態に当たる", of3(care(2), yes)],
      ["要介護度は不明・ほかの状態に当たる", of3(unknown, yes)],
    ])("%s：加算を立て、検証で指摘がない", (_, c) => {
      const r = derive(c);
      expect(r.pending).toEqual([]);
      expect(kubunOf(r)).toContain(C.hokatsu.kubun);
      expect(r03(c)).toEqual([]);
    });
    it("要介護 2・ほかの状態が不明：加算を保留（宛先は医師）し、検証も同じ事実の情報不足", () => {
      const c = of3(care(2), unknown);
      const r = derive(c);
      expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "table8_3Other", target: "doctor", blocks: [C.hokatsu.kubun] })]);
      expect(kubunOf(r)).not.toContain(C.hokatsu.kubun);
      expect(r03(c)).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target: "doctor", field: "table8_3Other" } })]);
    });
    it("要介護 2・ほかの状態にも当たらない（K4 の筋）：加算を立てず、検証で指摘がない", () => {
      const r = derive(K4_CARE2);
      expect(r.pending).toEqual([]);
      expect(kubunOf(r)).not.toContain(C.hokatsu.kubun);
      expect(r03(K4_CARE2)).toEqual([]);
    });
  });
});

describe("K5（看取り）", () => {
  it("答えがなければ、看取り加算・死亡診断加算・ターミナルケア加算はどれも行に入らず、要選択として返る", () => {
    const r = derive(K5, { choices: {} });
    const { mitori, shibou, terminal } = C.terminal;
    for (const k of [mitori, shibou, terminal]) expect(kubunOf(r)).not.toContain(k);
    expect(r.pending.map((p) => [p.kind, p.id])).toEqual([["要選択", `D11-mitori:${day(22)}`], ["要選択", `D12-terminal:${day(22)}`]]);
    expect(r.pending[0]).toMatchObject({ options: [{ id: "mitori", kubun: [mitori] }, { id: "shibou", kubun: [shibou] }, { id: "none", kubun: [] }] });
    expect(r.totalStatus).toBe("withheld");
    expect(wrongOrMissed(judge(K5, r).findings)).toEqual([]);
  });
  it("症例の choices（看取り加算・ターミナルケア加算）で導出すると、区分誤り・取り忘れが 0 件。行は choice を根拠に持つ", () => {
    const r = derive(K5);
    expect(r.pending).toEqual([]);
    expect(judge(K5, r).findings).toEqual([]);
    for (const k of [C.terminal.mitori, C.terminal.terminal]) expect(r.basis.find((b) => b.kubun === k)?.choice).toBeDefined();
    // 症例の行（EM §5-2 の小計 10,175）との差は、往診の日の再診料と「再診時等」の区分だけ（L-40。EM は K5 の合計を決めていない）
    const extra = r.lines.filter((l) => !K5.lines.some((x) => x.kubun === l.kubun));
    expect(extra.map((l) => l.kubun).sort()).toEqual([C.oushin.revisit, C.baseUp.revisit, C.price.revisit].sort());
    expect(sorted(r.lines.filter((l) => !extra.includes(l)))).toEqual(sorted(K5.lines));
    expect(judge(K5, r).total).toBe(10175 + 76 + 4 + 2);
    // 管理料は立てない（管理料を算定する患者ではない。L-17）
    expect(kubunOf(r).some((k) => k.startsWith("C002"))).toBe(false);
  });
  it("死亡診断加算を選べば死亡診断加算だけが立つ。どちらも算定しないを選べば立たない", () => {
    const id = `D11-mitori:${day(22)}`;
    expect(kubunOf(derive(K5, { choices: { [id]: "shibou" } }))).toContain(C.terminal.shibou);
    const none = derive(K5, { choices: { [id]: "none", [`D12-terminal:${day(22)}`]: "no" } });
    expect(none.pending).toEqual([]);
    expect(kubunOf(none)).not.toContain(C.terminal.mitori);
    expect(kubunOf(none)).not.toContain(C.terminal.shibou);
    expect(kubunOf(none)).not.toContain(C.terminal.terminal);
  });
  it("看取りの場所が不明なら、ターミナルケア加算は事実不足（宛先は医師）", () => {
    const r = derive(withFact(K5, "deathPlace", unknown));
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "deathPlace", target: "doctor" })]);
  });
  it("今の pending にない id への答えは無視して staleChoices に返す。選択肢にない答えは答えなしと同じ", () => {
    expect(derive(K1, { choices: { "D11-mitori:x": "mitori" } }).staleChoices).toEqual(["D11-mitori:x"]);
    expect(derive(K5, { choices: { [`D11-mitori:${day(22)}`]: "両方" } }).pending.map((p) => p.id)).toContain(`D11-mitori:${day(22)}`);
  });
});

describe("同じ日・翌日の訪問診療と往診（§2-3-4）", () => {
  const D = day(14);
  const oushin: ClaimEvent = { type: "oushin", date: D, kind: "normal" };
  const BOTH = withEvents(K2, oushin);
  const VISIT = C.visitKubun[0];
  const OUSHIN = C.oushin.kubun;
  /** R10・R08・R15 の指摘は、どの場合も 0 件 */
  const quiet = (c: ClaimContext, r: DeriveResult) => expect(judge(c, r).findings.filter((f) => ["R10", "R08", "R15"].includes(f.ruleId))).toEqual([]);

  it("その日の答えがなければ、訪問診療料と往診料の両方が事実不足（医療事務）で保留になり、どちらも行に入らない", () => {
    const r = derive(BOTH);
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "sameDaySeparate", target: "clerk", date: D })]);
    expect(datesOf(r, VISIT)).toEqual([day(28)]);
    expect(kubunOf(r)).not.toContain(OUSHIN);
    // 回数に依存する管理料と、その日の加算も立てない
    expect(kubunOf(r).some((k) => k.startsWith("C002"))).toBe(false);
    expect(datesOf(r, C.baseUp.visit[0])).toEqual([day(28)]);
    expect(r.totalStatus).toBe("withheld");
    quiet(BOTH, r);
  });
  it("1 回の診療（偽）なら要選択になり、選んだ方だけが立って、他方は notBilled に残る", () => {
    const c = withFact(BOTH, "sameDaySeparate", sep({ [D]: false }));
    const id = `D01-encounter:${D}`;
    const open = derive(c);
    expect(open.pending).toEqual([expect.objectContaining({ kind: "要選択", id })]);
    expect(datesOf(open, VISIT)).toEqual([day(28)]);
    expect(kubunOf(open)).not.toContain(OUSHIN);

    const v = derive(c, { choices: { [id]: "visit" } });
    expect(v.pending).toEqual([]);
    expect(datesOf(v, VISIT)).toEqual([D, day(28)]);
    expect(kubunOf(v)).not.toContain(OUSHIN);
    expect(v.notBilled).toEqual([{ event: { type: "oushin", date: D }, reason: "same_encounter" }]);
    expect(judge(c, v).findings).toEqual([]);

    const o = derive(c, { choices: { [id]: "oushin" } });
    expect(datesOf(o, VISIT)).toEqual([day(28)]);
    expect(datesOf(o, OUSHIN)).toEqual([D]);
    expect(o.notBilled).toEqual([{ event: { type: "visit", date: D }, reason: "same_encounter" }]);
    // 立てなかった訪問診療の日を、訪問診療時の区分にしない
    expect(datesOf(o, C.baseUp.visit[0])).toEqual([day(28)]);
    expect(datesOf(o, C.baseUp.revisit)).toEqual([D]);
    expect(datesOf(o, C.price.visit[0])).toEqual([day(28)]);
    expect(datesOf(o, C.price.revisit)).toEqual([D]);
    // 訪問診療料が 1 回になるので、管理料は月 1 回の区分
    expect(kubunOf(o)).toContain("C002_2NI1");
    expect(wrongOrMissed(judge(c, o).findings)).toEqual([]);
    quiet(c, v);
    quiet(c, o);
  });
  it("別々の診療（真）で文書提供済みなら両方が立つ。再診時等の区分は重ねない", () => {
    const c = withFact(BOTH, "sameDaySeparate", sep({ [D]: true }));
    const r = derive(c);
    expect(r.pending).toEqual([]);
    expect(datesOf(r, VISIT)).toEqual([D, day(28)]);
    expect(datesOf(r, OUSHIN)).toEqual([D]);
    expect(kubunOf(r)).not.toContain(C.baseUp.revisit);
    expect(kubunOf(r)).not.toContain(C.price.revisit);
    expect(kubunOf(r)).not.toContain(C.oushin.revisit);
    expect(judge(c, r).findings).toEqual([]);
  });
  it("別々の診療で文書提供なしなら往診料だけが立ち、訪問診療は notBilled に残る。文書提供が不明なら訪問診療料が事実不足（医療事務）", () => {
    const base = withFact(BOTH, "sameDaySeparate", sep({ [D]: true }));
    const c = withFact(base, "contactDocProvided", no);
    const r = derive(c);
    expect(datesOf(r, VISIT)).toEqual([day(28)]);
    expect(datesOf(r, OUSHIN)).toEqual([D]);
    expect(r.notBilled).toEqual([{ event: { type: "visit", date: D }, reason: "after_oushin" }]);
    expect(datesOf(r, C.baseUp.visit[0])).toEqual([day(28)]);
    expect(datesOf(r, C.baseUp.revisit)).toEqual([D]);
    quiet(c, r);

    const u = withFact(base, "contactDocProvided", unknown);
    const ru = derive(u);
    expect(ru.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "contactDocProvided", target: "clerk", date: D })]);
    expect(datesOf(ru, VISIT)).toEqual([day(28)]);
    expect(datesOf(ru, OUSHIN)).toEqual([D]);
    quiet(u, ru);
  });
  it("往診の翌日の訪問診療は、文書提供だけで決まる（提供済みなら立つ、なしなら立てない）", () => {
    const c = withEvents(K2, { type: "oushin", date: day(13), kind: "normal" });
    const ok = derive(c);
    expect(datesOf(ok, VISIT)).toEqual([D, day(28)]);
    expect(judge(c, ok).findings).toEqual([]);
    const ng = withFact(c, "contactDocProvided", no);
    const r = derive(ng);
    expect(datesOf(r, VISIT)).toEqual([day(28)]);
    expect(r.notBilled).toEqual([{ event: { type: "visit", date: D }, reason: "after_oushin" }]);
    quiet(ng, r);
  });
  describe("前日に往診料があり、同じ日の要選択で訪問診療料を選んだ日（X-74）", () => {
    /** 13 日に往診、14 日に訪問診療と往診（1 回の診療） */
    const base = withFact(withEvents(K2, { type: "oushin", date: day(13), kind: "normal" }, oushin), "sameDaySeparate", sep({ [D]: false }));
    const id = `D01-encounter:${D}`;
    const r10 = (c: ClaimContext, r: DeriveResult) => judge(c, r).findings.filter((f) => f.ruleId === "R10");
    it("文書提供なしなら、選んでも訪問診療料を立てず notBilled に残す（翌日の制限を飛ばさない）", () => {
      const c = withFact(base, "contactDocProvided", no);
      const r = derive(c, { choices: { [id]: "visit" } });
      expect(datesOf(r, VISIT)).toEqual([day(28)]);
      expect(datesOf(r, OUSHIN)).toEqual([day(13)]);
      expect(r.notBilled).toEqual([
        { event: { type: "oushin", date: D }, reason: "same_encounter" },
        { event: { type: "visit", date: D }, reason: "after_oushin" },
      ]);
      expect(r.pending).toEqual([]);
      expect(r10(c, r)).toEqual([]);
    });
    it("文書提供が不明なら訪問診療料を事実不足（医療事務）で保留にし、提供済みなら立てる", () => {
      const u = withFact(base, "contactDocProvided", unknown);
      const ru = derive(u, { choices: { [id]: "visit" } });
      expect(ru.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "contactDocProvided", target: "clerk", date: D })]);
      expect(datesOf(ru, VISIT)).toEqual([day(28)]);
      const ok = derive(base, { choices: { [id]: "visit" } });
      expect(datesOf(ok, VISIT)).toEqual([D, day(28)]);
      expect(judge(base, ok).findings).toEqual([]);
    });
    it("不変条件：保留のない導出の行を検証に通すと、R10 の指摘が出ない（同じ日の答え × 選択 × 文書提供の全組み合わせ）", () => {
      for (const separate of [true, false])
        for (const pick of ["visit", "oushin"])
          for (const doc of [yes, no]) {
            const c = withFact(withFact(base, "sameDaySeparate", sep({ [D]: separate })), "contactDocProvided", doc);
            const r = derive(c, { choices: separate ? {} : { [id]: pick } });
            const label = `separate=${separate} pick=${pick} doc=${doc.value}`;
            expect(r.pending, label).toEqual([]);
            expect(r10(c, r), label).toEqual([]);
          }
    });
  });
  it("緊急の往診は、対象の患者と確かめたときだけ緊急往診加算を立てる。不明なら事実不足（医療事務）", () => {
    const c = withEvents(K2, { type: "oushin", date: day(20), kind: "emergency" });
    expect(datesOf(derive(c), C.oushin.kinkyu)).toEqual([day(20)]);
    expect(judge(c, derive(c)).findings).toEqual([]);
    expect(kubunOf(derive(withFact(c, "emergencyEligible", no)))).not.toContain(C.oushin.kinkyu);
    expect(derive(withFact(c, "emergencyEligible", unknown)).pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "emergencyEligible", target: "clerk" })]);
  });
});

describe("管理料・保留・未対応・見込み", () => {
  it("施設入居等・重症でない・回数 2・注16 の基準を満たさない施設で、施設総管 2ニ が立つ", () => {
    const c = withFacility(K4_CARE2, { note16Met: no });
    const r = derive(c);
    expect(kubunOf(r)).toContain("C002-2_2NI1");
    expect(judge(c, r).findings).toEqual([]);
  });
  it("別表第八の二が不明なら管理料が保留（事実不足・宛先は医師）で、合計を出さない", () => {
    const r = derive(withFact(K2, "table8_2", unknown));
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "table8_2", target: "doctor" })]);
    expect(kubunOf(r).some((k) => k.startsWith("C002"))).toBe(false);
    expect(r.totalStatus).toBe("withheld");
  });
  it("管理料を算定する患者かが不明なら管理料が保留（医療事務）。当たらなければ管理料を立てず、処方箋料を立てる", () => {
    expect(derive(withFact(K2, "comprehensiveCare", unknown)).pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "comprehensiveCare", target: "clerk" })]);
    const c = withFact(K2, "comprehensiveCare", no);
    const r = derive(c);
    expect(kubunOf(r).some((k) => k.startsWith("C002"))).toBe(false);
    expect(datesOf(r, C.rx.other)).toEqual([day(28)]);
    expect(judge(c, r).findings).toEqual([]);
  });
  it("処方箋料の区分は処方ごとに決める：1 日に内服 5 種類、20 日に 7 種類なら 60＋32＝92 点（X-77）", () => {
    const rx = (n: number, oralKinds: number): ClaimEvent => ({ type: "prescription", date: day(n), oralKinds, days: 28 });
    const c: ClaimContext = { ...withFact(K2, "comprehensiveCare", no), events: [...K2.events.filter((e) => e.type !== "prescription"), rx(1, 5), rx(20, 7)] };
    const r = derive(c);
    expect(r.pending).toEqual([]);
    expect(datesOf(r, C.rx.other)).toEqual([day(1)]);
    expect(datesOf(r, C.rx.many)).toEqual([day(20)]);
    const result = judge(c, r);
    const pointsOfRx = [C.rx.other, C.rx.many].map((k) => result.byLine.find((b) => b.kubun === k)?.points);
    expect(pointsOfRx).toEqual([60, 32]);
    expect(result.findings).toEqual([]);
    for (const k of [C.rx.other, C.rx.many]) expect(r.basis.find((b) => b.kubun === k)?.events).toHaveLength(1);
  });
  it("居住の場所・注16（区分を左右するとき）・施設の届出が不明なら、その区分だけ保留になる", () => {
    expect(derive(withFact(K2, "residence", unknown)).pending.map((p) => p.kind === "事実不足" && p.need)).toEqual(["residence"]);
    expect(derive(withFacility(K2, { note16Met: unknown })).pending.map((p) => p.kind === "事実不足" && p.need)).toEqual(["facility.note16Met"]);
    // K1 は重症区分なので、注16 が不明でも保留にならない
    expect(derive(withFacility(K1, { note16Met: unknown })).pending).toEqual([]);
    const r = derive(withFacility(K2, { dxTier: unknown, baseUp: unknown, priceResponse: unknown }));
    expect(r.pending.map((p) => p.kind === "事実不足" && [p.need, p.target])).toEqual([["facility.dxTier", "clerk"], ["facility.baseUp", "clerk"], ["facility.priceResponse", "clerk"]]);
    expect(kubunOf(r)).toContain("C002_2RO1");
  });
  it("機能強化型・同一建物 2 人以上の訪問・ベースアップ評価料の注5・表にない検査の項目は unsupported で、合計を出さない", () => {
    const kyoka = derive(withFacility(K2, { kyokagata: true }));
    expect(kyoka.unsupported.map((u) => u.code)).toEqual(["kyokagata"]);
    expect(kubunOf(kyoka).some((k) => k.startsWith("C002"))).toBe(false);
    const multi = derive({ ...K2, events: K2.events.map((e) => (e.type === "visit" ? { ...e, sameBuildingCount: 3 } : e)) });
    expect(multi.unsupported.map((u) => u.code)).toEqual(["single_building_multi"]);
    expect(kubunOf(multi)).toContain(C.visitKubun[1]);
    expect(kubunOf(multi)).toContain(C.baseUp.visit[1]);
    const note5 = derive(withFacility(K2, { baseUp: { known: true, value: "注5" } }));
    expect(note5.unsupported.map((u) => u.code)).toEqual(["baseup_note5"]);
    const item = derive(withEvents(K2, { type: "test", date: day(28), items: ["表にない検査"] }));
    expect(item.unsupported).toEqual([{ code: "unmapped_test_item", detail: "表にない検査" }]);
    for (const r of [kyoka, multi, note5, item]) expect(r.totalStatus).toBe("withheld");
  });
  it("asOf を渡すと、管理料とそれに付く加算の行が見込み（tentative）になり、totalStatus も tentative", () => {
    const mid = contextAsOf(K2, day(14));
    const r = derive(mid, { asOf: day(14) });
    expect(r.totalStatus).toBe("tentative");
    expect(r.basis.filter((b) => b.tentative).map((b) => b.kubun)).toEqual(["C002_2NI1", C.hokatsu.kubun, C.ikou.kubun]);
    // 月の途中は、月末まで決まらないルールを伏せると指摘が出ない
    expect(deferAtMidMonth(judge(mid, r)).findings).toEqual([]);
  });
  it("カルテ→出来事→導出→検証の流れ：書いた訪問が出来事になり、その日までの行が立つ", () => {
    const mid = contextAsOf(K4_CARE2, day(20));
    const note = { s: "", o: "", a: "", p: "", rx: "" };
    const { events, facts } = eventsFromNotes(mid.events, mid.facts, [{ date: day(20), kind: "訪問診療", note, facts: [] }]);
    const c = { ...mid, events, facts };
    const r = derive(c, { asOf: day(20) });
    expect(datesOf(r, C.visitKubun[0])).toEqual([day(13), day(20)]);
    expect(kubunOf(r)).toContain("C002-2_2RO1");
    expect(wrongOrMissed(deferAtMidMonth(judge(c, r)).findings)).toEqual([]);
  });
});

describe("不変条件（§2-8）", () => {
  const inputs: [string, ClaimContext][] = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"].map((n) => [n, loadCase(n)]);
  it.each(inputs)("%s：同じ入力なら同じ出力。導出した行はすべて根拠を持ち、根拠は出来事を 1 つ以上指す。導出するのは決まった区分だけ", (_n, c) => {
    const r = derive(c);
    expect(derive(c)).toEqual(r);
    const derived = r.lines.slice(0, r.basis.length);
    expect(derived.map((l) => [l.kubun, l.dates])).toEqual(r.basis.map((b) => [b.kubun, b.dates]));
    for (const b of r.basis) expect(b.events.length, b.kubun).toBeGreaterThan(0);
    const allowed = derivedKubun(C);
    for (const l of derived) expect(allowed).toContain(l.kubun);
    expect(r.lines.slice(r.basis.length)).toEqual(manualLinesOf(c.lines, REV));
    expect(wrongOrMissed(judge(c, r).findings)).toEqual([]);
  });
  it("manual に導出する区分を入れると例外", () => {
    expect(() => derive(K1, { manual: [line("C001_1I")] })).toThrow(/導出する区分/);
  });
  it("manual を足して出る指摘は、導出の外の判定（背反など）だけ", () => {
    const c = K1;
    const r = derive(c, { manual: [...manualLinesOf(c.lines, REV), line("C101_2I")] });
    expect(judge(c, r).findings.map((f) => `${f.ruleId}:${f.kind}`)).toEqual(["R04:背反"]);
  });
  it("src/engine は src/mentor と LLM の SDK を import しない", () => {
    const dir = path.join(__dirname, "..", "..", "src", "engine");
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    expect(files(dir).length).toBeGreaterThan(20);
    for (const f of files(dir)) {
      const imports = [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(/mentor|@anthropic-ai|claude-agent-sdk/.test(i), `${f}: ${i}`).toBe(false);
    }
  });
});

describe("ターミナルケア加算の回数：同じ日の訪問診療と往診（X-73）", () => {
  const D = day(21);
  const DEATH = day(22);
  const TERMINAL = C.terminal.terminal;
  const tid = `D12-terminal:${DEATH}`;
  /** 21 日に訪問診療と往診の出来事、22 日に在宅で死亡。ほかの訪問はない */
  const ONE_DAY: ClaimContext = {
    ...K5,
    events: [
      { type: "visit", date: D, sameBuildingCount: 1 },
      { type: "oushin", date: D, kind: "normal" },
      { type: "death", date: DEATH },
    ],
    lines: [],
  };
  const choices = { [`D01-encounter:${D}`]: "visit", [`D11-mitori:${DEATH}`]: "none", [tid]: "yes" };
  it("別々の診療でない日は 1 回なので、ターミナルケア加算を聞かず、答えがあっても立てない", () => {
    const c = withFact(ONE_DAY, "sameDaySeparate", sep({ [D]: false }));
    const r = derive(c, { choices });
    expect(r.pending).toEqual([]);
    expect(kubunOf(r)).not.toContain(TERMINAL);
    expect(r.staleChoices).toEqual([tid]);
    expect(judge(c, r).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
  });
  it("別々の診療と確かめた日は 2 回なので、選べば立つ", () => {
    const c = withFact(ONE_DAY, "sameDaySeparate", sep({ [D]: true }));
    const r = derive(c, { choices });
    expect(kubunOf(r)).toContain(TERMINAL);
    expect(judge(c, r).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
  });
  it("確かめていない日で回数が決まらないときは、その日の事実不足がターミナルケア加算も保留にする", () => {
    const r = derive(ONE_DAY, { choices });
    expect(r.pending.map((p) => p.id)).toEqual([`D01-sameDay:${D}`]);
    expect(r.pending[0].blocks).toContain(TERMINAL);
    expect(kubunOf(r)).not.toContain(TERMINAL);
  });
});
