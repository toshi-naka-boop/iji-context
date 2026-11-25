// design.md §7 #16：算定行の導出（§2-8 の不変条件 1〜6、症例との一致、同じ日の訪問診療と往診、保留・未対応・見込み）
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimPreviewOf } from "../../src/chart/claim";
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
  describe("包括的支援加算（D04）：別表第八の三の場合分けで、導出と検証（R03）が同じ答えになる（design.md §11-4）", () => {
    const num = (n: number) => ({ known: true, value: n }) as const;
    type F = ClaimContext["facts"];
    const of3 = (careLevel: F["careLevel"], level: F["disabilitySupportLevel"], other: F["table8_3Other"]) =>
      withFact(withFact(withFact(K4, "careLevel", careLevel), "disabilitySupportLevel", level), "table8_3Other", other);
    const r03 = (c: ClaimContext) => judge(c, derive(c)).findings.filter((f) => f.ruleId === "R03");
    it.each([
      ["要介護 3・ほかは不明", of3(num(3), unknown, unknown)],
      ["障害支援区分 2・ほかは不明", of3(unknown, num(2), unknown)],
      ["要介護 2・障害支援区分なし・ほかの状態に当たる", of3(num(2), num(0), yes)],
      ["要介護度と障害支援区分は不明・ほかの状態に当たる", of3(unknown, unknown, yes)],
    ])("%s：加算を立て、検証で指摘がない", (_, c) => {
      const r = derive(c);
      expect(r.pending).toEqual([]);
      expect(kubunOf(r)).toContain(C.hokatsu.kubun);
      expect(r03(c)).toEqual([]);
    });
    it.each([
      ["要介護度が不明", of3(unknown, unknown, unknown), "careLevel", "clerk"],
      ["要介護 2・障害支援区分が不明", of3(num(2), unknown, unknown), "disabilitySupportLevel", "clerk"],
      ["要介護 2・障害支援区分 1・ほかの状態が不明", of3(num(2), num(1), unknown), "table8_3Other", "doctor"],
    ] as const)("%s：加算を保留し、検証も同じ事実の情報不足（宛先も同じ）", (_, c, need, target) => {
      const r = derive(c);
      expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need, target, blocks: [C.hokatsu.kubun] })]);
      expect(kubunOf(r)).not.toContain(C.hokatsu.kubun);
      expect(r.totalStatus).toBe("withheld");
      expect(r03(c)).toEqual([expect.objectContaining({ kind: "情報不足", missing: { target, field: need } })]);
    });
    it("要介護 2・障害支援区分なし・ほかの状態にも当たらない（K4 の筋）：加算を立てず、検証で指摘がない", () => {
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
    for (const k of [C.terminal.mitori, C.terminal.terminal["2"]!]) expect(r.basis.find((b) => b.kubun === k)?.choice).toBeDefined();
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
    expect(kubunOf(none)).not.toContain(C.terminal.terminal["2"]!);
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

  /** その日、訪問診療のあとに、急変などで往診したか */
  const after = (c: ClaimContext, v: Record<string, boolean>) => withFact(c, "sameDayOushinAfterVisit", sep(v));

  it("その日の答えがなければ、訪問診療料と往診料の両方が事実不足（医療事務）で保留になり、どちらも行に入らない", () => {
    const r = derive(BOTH);
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "sameDayOushinAfterVisit", target: "clerk", date: D })]);
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
  it("別々の診療と確かめただけでは往診料を立てない（あとの往診かを聞く）。あとの往診でなければ、別々の診療かを聞く", () => {
    const r = derive(withFact(BOTH, "sameDaySeparate", sep({ [D]: true })));
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "sameDayOushinAfterVisit", target: "clerk", date: D })]);
    expect(kubunOf(r)).not.toContain(OUSHIN);
    const r2 = derive(after(BOTH, { [D]: false }));
    expect(r2.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "sameDaySeparate", target: "clerk", date: D })]);
    expect(kubunOf(r2)).not.toContain(OUSHIN);
  });
  it("別々の診療だが、あとの往診ではない（往診が先など）：往診料は立てず notBilled に残し、訪問診療料は文書提供によらず立つ", () => {
    for (const doc of [yes, no, unknown]) {
      const c = withFact(after(withFact(BOTH, "sameDaySeparate", sep({ [D]: true })), { [D]: false }), "contactDocProvided", doc);
      const r = derive(c);
      expect(r.pending).toEqual([]);
      expect(datesOf(r, VISIT)).toEqual([D, day(28)]);
      expect(kubunOf(r)).not.toContain(OUSHIN);
      expect(kubunOf(r)).not.toContain(C.oushin.revisit);
      expect(r.notBilled).toEqual([{ event: { type: "oushin", date: D }, reason: "oushin_not_after_visit" }]);
      expect(sorted(r.lines)).toEqual(sorted(K2.lines));
      expect(judge(c, r).findings).toEqual([]);
    }
  });
  it("月に 2 日あるとき、片方の日の答えはもう片方に効かない", () => {
    const D2 = day(28);
    const two = withEvents(BOTH, { type: "oushin", date: D2, kind: "normal" });
    const r = derive(after(two, { [D]: true }));
    expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "sameDayOushinAfterVisit", date: D2 })]);
    expect(datesOf(r, VISIT)).toEqual([D]);
    expect(datesOf(r, OUSHIN)).toEqual([D]);
  });
  it("訪問診療のあとの往診（真）で文書提供済みなら両方が立つ。別々の診療かは聞かない。再診時等の区分は重ねない", () => {
    const c = withFact(after(BOTH, { [D]: true }), "sameDaySeparate", unknown);
    const r = derive(c);
    expect(r.pending).toEqual([]);
    expect(datesOf(r, VISIT)).toEqual([D, day(28)]);
    expect(datesOf(r, OUSHIN)).toEqual([D]);
    expect(kubunOf(r)).not.toContain(C.baseUp.revisit);
    expect(kubunOf(r)).not.toContain(C.price.revisit);
    expect(kubunOf(r)).not.toContain(C.oushin.revisit);
    expect(judge(c, r).findings).toEqual([]);
  });
  it("あとの往診で文書提供なしなら往診料だけが立ち、訪問診療は notBilled に残る。文書提供が不明なら訪問診療料が事実不足（医療事務）", () => {
    const base = after(BOTH, { [D]: true });
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
    it("表示：往診料が立たない理由（1 回の診療として訪問診療料を選んだ）と、訪問診療料の保留（文書の提供）を分けて出す（§11-5）", () => {
      const u = withFact(base, "contactDocProvided", unknown);
      const r = derive(u, { choices: { [id]: "visit" } });
      const p = claimPreviewOf(r, judge(u, r), REV);
      const md = `${Number(D.slice(5, 7))}/${Number(D.slice(8, 10))}`;
      expect(p.notBilled).toEqual([`往診 ${md}：1 回の診療として訪問診療料を選んだので、行にしていません`]);
      expect(p.pending.map((x) => [x.kind, x.text])).toEqual([["事実不足", `連絡担当者・往診担当医などの文書を患者に提供しているか（${md}）`]]);
      // 文書の提供がないと分かれば、訪問診療料の理由は別の文で出る
      const n = withFact(base, "contactDocProvided", no);
      const rn = derive(n, { choices: { [id]: "visit" } });
      expect(claimPreviewOf(rn, judge(n, rn), REV).notBilled).toEqual([
        `往診 ${md}：1 回の診療として訪問診療料を選んだので、行にしていません`,
        `訪問診療 ${md}：往診の日・その翌日の訪問診療で、連絡先などの文書を提供している患者ではないので、行にしていません`,
      ]);
    });
    it("不変条件：保留のない導出の行を検証に通すと、R10 の指摘が出ない（同じ日の 2 つの答え × 選択 × 文書提供の全組み合わせ）", () => {
      const answers = [true, false, undefined];
      for (const separate of answers)
        for (const afterVisit of answers)
          for (const pick of ["visit", "oushin"])
            for (const doc of [yes, no]) {
              const table = (v: boolean | undefined) => sep(v === undefined ? {} : { [D]: v });
              const c = withFact(withFact(withFact(base, "sameDaySeparate", table(separate)), "sameDayOushinAfterVisit", table(afterVisit)), "contactDocProvided", doc);
              const r = derive(c, { choices: { [id]: pick } });
              const label = `separate=${separate} after=${afterVisit} pick=${pick} doc=${doc.value}`;
              // 決まらない組み合わせ（保留が残る）でも、立てた行に R10 の指摘は出ない
              expect(r10(c, r).filter((f) => f.kind !== "情報不足"), label).toEqual([]);
              if (r.pending.length === 0) expect(r10(c, r), label).toEqual([]);
              // 保留が残るのは、関係が決まらない組み合わせだけ
              expect(r.pending.length > 0, label).toBe(separate !== false && afterVisit !== true && (afterVisit === undefined || separate === undefined));
            }
    });
  });
  it("緊急の往診は、対象の患者と確かめたときだけ緊急往診加算を立てる。不明なら事実不足（医療事務）", () => {
    const c = withEvents(K2, { type: "oushin", date: day(20), kind: "emergency" });
    expect(datesOf(derive(c), C.oushin.kinkyu["2"]!)).toEqual([day(20)]);
    expect(judge(c, derive(c)).findings).toEqual([]);
    expect(kubunOf(derive(withFact(c, "emergencyEligible", no)))).not.toContain(C.oushin.kinkyu["2"]!);
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
    const rx = (n: number, oralKinds: number): ClaimEvent => ({ type: "prescription", date: day(n), oralKinds, days: 28, psychotropic: false });
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
  describe("処方箋料（D10）：6 種類以下の処方と、向精神薬の長期処方（design.md §11-5。§11-8 完了条件 9）", () => {
    const D = day(28);
    /** K2 を管理料のない月にして、28 日の処方（内服 5 種類）の「対象の薬が含まれるか」を差し替える */
    const of = (psychotropic: boolean | null, table?: Record<string, boolean>): ClaimContext => ({
      ...withFact(withFact(K2, "comprehensiveCare", no), "rxLongPsychotropic", table ? sep(table) : unknown),
      events: K2.events.map((e) => (e.type === "prescription" ? { ...e, psychotropic } : e)),
    });
    const r07 = (c: ClaimContext, r: DeriveResult) => judge(c, r).findings.filter((f) => f.ruleId === "R07");
    it.each([null, true])("長期処方かが不明の日（psychotropic=%s）は、処方箋料を保留（事実不足・宛先は医師・その日つき）にして合計を出さない。区分 3 とみなさない", (psy) => {
      const r = derive(of(psy));
      expect(r.pending).toEqual([expect.objectContaining({ kind: "事実不足", id: `D10-long:${D}`, need: "rxLongPsychotropic", target: "doctor", date: D, blocks: [C.rx.many, C.rx.other] })]);
      expect(kubunOf(r)).not.toContain(C.rx.other);
      expect(kubunOf(r)).not.toContain(C.rx.many);
      expect(r.totalStatus).toBe("withheld");
    });
    it("長期処方が真なら区分 2、偽なら区分 3 を立て、どちらも検証で指摘がない", () => {
      for (const [answer, kubun] of [[true, C.rx.many], [false, C.rx.other]] as const) {
        const c = of(true, { [D]: answer });
        const r = derive(c);
        expect(r.pending).toEqual([]);
        expect(datesOf(r, kubun)).toEqual([D]);
        expect(r.basis.find((b) => b.kubun === kubun)?.needs).toEqual(["rxLongPsychotropic"]);
        expect(r07(c, r)).toEqual([]);
      }
    });
    it("処方に対象の薬が含まれないと分かっている日は聞かれず、区分 3 が立つ", () => {
      const c = of(false);
      const r = derive(c);
      expect(r.pending).toEqual([]);
      expect(datesOf(r, C.rx.other)).toEqual([D]);
      expect(r.basis.find((b) => b.kubun === C.rx.other)?.needs).toEqual([]);
      expect(r07(c, r)).toEqual([]);
    });
    it("同じ日に処方が 2 回ある日は、処方箋料を立てず unsupported にして合計を出さない", () => {
      const c: ClaimContext = { ...of(false), events: [...of(false).events, { type: "prescription", date: D, oralKinds: 7, days: 28, psychotropic: false }] };
      const r = derive(c);
      expect(r.unsupported.map((u) => u.code)).toEqual(["rx_same_day_multi"]);
      expect(kubunOf(r)).not.toContain(C.rx.other);
      expect(kubunOf(r)).not.toContain(C.rx.many);
      expect(r.totalStatus).toBe("withheld");
    });
  });
  it("居住の場所・注16（区分を左右するとき）・施設の届出が不明なら、その区分だけ保留になる（聞くのは住まいの種別。design.md §18-2 C-494）", () => {
    expect(derive(withFact(K2, "residence", unknown)).pending.map((p) => p.kind === "事実不足" && p.need)).toEqual(["residenceType"]);
    expect(derive(withFacility(K2, { note16Met: unknown })).pending.map((p) => p.kind === "事実不足" && p.need)).toEqual(["facility.note16Met"]);
    // K1 は重症区分なので、注16 が不明でも保留にならない
    expect(derive(withFacility(K1, { note16Met: unknown })).pending).toEqual([]);
    const r = derive(withFacility(K2, { dxTier: unknown, baseUp: unknown, priceResponse: unknown }));
    expect(r.pending.map((p) => p.kind === "事実不足" && [p.need, p.target])).toEqual([["facility.dxTier", "clerk"], ["facility.baseUp", "clerk"], ["facility.priceResponse", "clerk"]]);
    expect(kubunOf(r)).toContain("C002_2RO1");
  });
  it("表にない検査の項目は unsupported で、合計を出さない（機能強化型と注5 は段 17d、単一建物 2 人以上は段 17f で導出する）", () => {
    const kyoka = derive(withFacility(K2, { grade: { known: true, value: "1N" }, kyokagata: true }));
    expect(kyoka.unsupported).toEqual([]);
    expect(kubunOf(kyoka)).toContain("C002_1N_RO1");
    // 同一建物居住者の訪問で、患者ごとの人数の区分を 2〜9 人と確かめた：人数の区分の管理料を立てる（段 17f。design.md §15-4）
    const multi = derive({
      ...withFacility(K2, { building: { known: true, value: "some" } }),
      facts: { ...K2.facts, buildingBand: { known: true, value: "2-9" } },
      events: K2.events.map((e) => (e.type === "visit" ? { ...e, sameBuildingCount: 3 } : e)),
    });
    expect(multi.unsupported).toEqual([]);
    expect(kubunOf(multi)).toContain(C.visitKubun[1]);
    expect(kubunOf(multi)).toContain(C.baseUp.visit[1]);
    expect(kubunOf(multi)).toContain("C002_2RO2");
    const note5 = derive(withFacility(K2, { baseUp: { known: true, value: "注5" } }));
    expect(note5.unsupported).toEqual([]);
    expect(kubunOf(note5)).toContain("O001_3I_N5");
    const item = derive(withEvents(K2, { type: "test", date: day(28), items: ["表にない検査"] }));
    expect(item.unsupported).toEqual([{ code: "unmapped_test_item", detail: "表にない検査" }]);
    expect(item.totalStatus).toBe("withheld");
    for (const r of [kyoka, note5, multi]) expect(r.totalStatus).toBe("ok");
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

describe("不変条件：段 5 で足した事実の全組み合わせ（design.md §11-8 完了条件 11）", () => {
  const D = day(14);
  const RX = day(28);
  const tri = [unknown, yes, no] as const;
  /** 日付ごとの事実の 3 通り（答えなし・真・偽） */
  const table = (d: string) => [sep({}), sep({ [d]: true }), sep({ [d]: false })];
  const levels = (...ns: number[]) => [unknown, ...ns.map((n) => ({ known: true, value: n }) as const)];
  /** 保留・未対応がなければ、足した事実に関わるルールの指摘は 1 件も出ない。保留があっても、区分誤り・取り忘れは出ない */
  function check(c: ClaimContext, choices: Record<string, string>, label: string) {
    const r = derive(c, { choices });
    const findings = judge(c, r).findings;
    expect(wrongOrMissed(findings), label).toEqual([]);
    if (r.pending.length === 0 && r.unsupported.length === 0) expect(findings.filter((f) => ["R03", "R07", "R08", "R09", "R10", "R15"].includes(f.ruleId)), label).toEqual([]);
    return r;
  }
  it("管理料の月：要介護度 × 障害支援区分 × ほかの状態 × 同じ日の 2 つの答え × 文書提供 × 要選択の答え", () => {
    const base = withEvents(K2, { type: "oushin", date: D, kind: "normal" });
    let n = 0;
    let decided = 0;
    for (const care of levels(2, 3))
      for (const level of levels(0, 2))
        for (const other of tri)
          for (const separate of table(D))
            for (const afterVisit of table(D))
              for (const doc of tri)
                for (const pick of ["visit", "oushin"]) {
                  const facts = { ...base.facts, careLevel: care, disabilitySupportLevel: level, table8_3Other: other, sameDaySeparate: separate, sameDayOushinAfterVisit: afterVisit, contactDocProvided: doc };
                  const r = check({ ...base, facts }, { [`D01-encounter:${D}`]: pick }, JSON.stringify({ care, level, other, separate, afterVisit, doc, pick }));
                  n++;
                  if (r.pending.length === 0) decided++;
                }
    expect(n).toBe(3 * 3 * 3 * 3 * 3 * 3 * 2);
    // 空振りしていない：保留なしで決まる組み合わせが実際にある
    expect(decided).toBeGreaterThan(100);
  });
  it("管理料のない月：内服の種類数 × 対象の薬が含まれるか × 長期処方か × 同じ日の 2 つの答え", () => {
    const base = withEvents(withFact(K2, "comprehensiveCare", no), { type: "oushin", date: RX, kind: "normal" });
    let decided = 0;
    for (const oralKinds of [5, 7])
      for (const psychotropic of [null, true, false])
        for (const long of table(RX))
          for (const separate of table(RX))
            for (const afterVisit of table(RX))
              for (const pick of ["visit", "oushin"]) {
                const c: ClaimContext = {
                  ...base,
                  facts: { ...base.facts, rxLongPsychotropic: long, sameDaySeparate: separate, sameDayOushinAfterVisit: afterVisit },
                  events: base.events.map((e) => (e.type === "prescription" ? { ...e, oralKinds, psychotropic } : e)),
                };
                const r = check(c, { [`D01-encounter:${RX}`]: pick }, JSON.stringify({ oralKinds, psychotropic, long, separate, afterVisit, pick }));
                if (r.pending.length === 0) {
                  decided++;
                  // 決まったときは、処方箋料がどちらかの区分で 1 回立っている
                  expect([C.rx.other, C.rx.many].filter((k) => kubunOf(r).includes(k))).toHaveLength(1);
                } else if (r.pending.some((p) => p.kind === "事実不足" && p.need === "rxLongPsychotropic")) {
                  // 長期処方かが不明の間は、処方箋料をどちらの区分でも立てない
                  for (const k of [C.rx.other, C.rx.many]) expect(kubunOf(r)).not.toContain(k);
                }
              }
    expect(decided).toBeGreaterThan(50);
  });
  it("看取りの月：同じ日の 2 つの答え × 退院時共同指導料1 × ターミナルケア加算を選ぶか", () => {
    const DAY = day(21);
    const DEATH = day(22);
    const base: ClaimContext = { ...K5, events: [{ type: "visit", date: DAY, sameBuildingCount: 1 }, { type: "oushin", date: DAY, kind: "normal" }, { type: "death", date: DEATH }], lines: [] };
    let billed = 0;
    for (const separate of table(DAY))
      for (const afterVisit of table(DAY))
        for (const guidance of tri)
          for (const pick of ["visit", "oushin"])
            for (const terminal of ["yes", "no"]) {
              const facts = { ...base.facts, sameDaySeparate: separate, sameDayOushinAfterVisit: afterVisit, dischargeJointGuidance: guidance };
              const choices = { [`D01-encounter:${DAY}`]: pick, [`D11-mitori:${DEATH}`]: "mitori", [`D12-terminal:${DEATH}`]: terminal };
              const label = JSON.stringify({ separate, afterVisit, guidance, pick, terminal });
              const c = { ...base, facts };
              const r = check(c, choices, label);
              // ターミナルケア加算を立てたなら、保留が残っていても、検証で要件不足にならない（導出と R09 が同じ述語を使う）
              if (kubunOf(r).includes(C.terminal.terminal["2"]!)) {
                billed++;
                expect(judge(c, r).findings.filter((f) => f.ruleId === "R09"), label).toEqual([]);
              }
            }
    expect(billed).toBeGreaterThan(10);
  });
});

describe("ターミナルケア加算の回数：同じ日の訪問診療と往診（X-73）", () => {
  const D = day(21);
  const DEATH = day(22);
  const TERMINAL = C.terminal.terminal["2"]!;
  const tid = `D12-terminal:${DEATH}`;
  /** 21 日に訪問診療と往診の出来事、22 日に在宅で死亡。ほかの訪問はない。退院時共同指導料1 は算定していない */
  const ONE_DAY: ClaimContext = {
    ...withFact(K5, "dischargeJointGuidance", no),
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
    // 算定プレビューにも、使わなかった答えとして届く（round-21 O-8）
    expect(claimPreviewOf(r, judge(c, r), REV).staleChoices).toEqual([tid]);
    expect(judge(c, r).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
  });
  it("別々の診療と確かめた日は 2 回なので、選べば立つ", () => {
    const c = withFact(ONE_DAY, "sameDaySeparate", sep({ [D]: true }));
    const r = derive(c, { choices });
    expect(kubunOf(r)).toContain(TERMINAL);
    expect(judge(c, r).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
  });
  it("別の経路：回数が 1 回でも、退院時共同指導料1 を算定していれば選べば立つ。不明なら事実不足（医療事務）で保留し、合計を出さない（§11-5）", () => {
    const short = withFact(ONE_DAY, "sameDaySeparate", sep({ [D]: false }));
    const ok = withFact(short, "dischargeJointGuidance", yes);
    const r = derive(ok, { choices });
    expect(r.pending).toEqual([]);
    expect(kubunOf(r)).toContain(TERMINAL);
    expect(judge(ok, r).findings.filter((f) => f.ruleId === "R09")).toEqual([]);
    const u = withFact(short, "dischargeJointGuidance", unknown);
    const ru = derive(u, { choices });
    expect(ru.pending).toEqual([expect.objectContaining({ kind: "事実不足", need: "dischargeJointGuidance", target: "clerk", blocks: [TERMINAL] })]);
    expect(kubunOf(ru)).not.toContain(TERMINAL);
    expect(ru.totalStatus).toBe("withheld");
  });
  it("確かめていない日で回数が決まらないときは、その日の事実不足がターミナルケア加算も保留にする", () => {
    const r = derive(ONE_DAY, { choices });
    expect(r.pending.map((p) => p.id)).toEqual([`D01-sameDay:${D}`]);
    expect(r.pending[0].blocks).toContain(TERMINAL);
    expect(kubunOf(r)).not.toContain(TERMINAL);
  });
});
