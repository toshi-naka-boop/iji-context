// design.md §11-11 完了条件 (e)(f)・§11-13 完了条件 (d)：点検の対象外の単位がある請求（partial）で出す指摘。
// 出すのは、ルールが soundWhenPartial に申告した種類（いまある行と確かめた事実だけから言えるもの）だけ。申告が正しいことを、ここで縛る：
// 同梱の症例と練習問題の入力それぞれについて、行を 1 行ずつ・1 区分ずつ対象外に移した入力を作り、「partial で出た指摘は、移す前の入力でも同じ行に出ている」を確かめる
import { describe, expect, it } from "vitest";
import { loadSources } from "../../scripts/gen-uke";
import { evaluate, rulesOf } from "../../src/engine";
import { warekiOf } from "../../src/engine/comments";
import { REVISIONS } from "../../src/engine/revisions";
import type { Revision } from "../../src/engine/revisions/types";
import type { ClaimContext, Finding } from "../../src/engine/types";
import { findingText } from "../../src/messages";
import { DOCTOR_DRILLS } from "../../src/practice/doctor-drills";
import { DRILLS } from "../../src/practice/drills";
import { commentsOfCase } from "../../src/uke/cases";
import { commentOf } from "../../src/uke/uke";
import { day, YM } from "../helpers/period";
import { line, loadCase, withFact, withLines, without } from "./helpers";

const NAMES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const { src } = loadSources();
/** 同梱の症例を、UKE から作った請求と同じ形（必須のコメントつき・commentsKnown が真）にする */
const ukeCase = (name: string): ClaimContext => {
  const c = loadCase(name);
  return { ...c, comments: commentsOfCase(c, src.commentValues?.[c.claimId]), commentsKnown: true };
};
/** 同じ行と事実のまま、カルテ側の記録がない請求にする（取り込んだ UKE の形） */
const noRecords = (c: ClaimContext): ClaimContext => ({ ...c, events: [], recordsKnown: false });
const nameOf = (claimId: string) => claimId.split("-")[0];

/** 指摘の種類（messageKey の「ルール id.」より後ろ） */
const keyOf = (f: Finding) => f.messageKey.slice(f.ruleId.length + 1);
/** 指摘（情報不足は除く。確かめる事実を聞くだけで、誤りとは言っていない） */
const claimsOf = (c: ClaimContext, revs?: Revision[]) => evaluate(c, revs).findings.filter((f) => f.kind !== "情報不足");
/** 区分のまとまり（区分のキーの、最初の「_」より前。C002_2I1 と C002_N10_HOKATSU は同じ C002） */
const groupOf = (kubun: string) => kubun.split("_")[0];

/** 行の一部を対象外に移した入力（その行を除き、partial を真にする。コメントはそのまま残る）：1 行ずつと、1 区分ずつ */
function moved(c: ClaimContext): { what: string; ctx: ClaimContext }[] {
  const out = c.lines.map((l, i) => ({ what: `行 ${l.kubun}`, ctx: { ...c, lines: c.lines.filter((_, j) => j !== i), partial: true } }));
  for (const g of new Set(c.lines.map((l) => groupOf(l.kubun)))) out.push({ what: `区分 ${g}`, ctx: { ...c, lines: c.lines.filter((l) => groupOf(l.kubun) !== g), partial: true } });
  return out;
}

/**
 * 申告に反する指摘：行を移した入力で出た指摘のうち、移す前の入力の同じ種類（R17 は同じ記載）の指摘の行に収まらないもの。
 * seen には、行を移した入力で実際に出た指摘の種類を入れる（空振りの確認に使う）
 */
function violations(inputs: { name: string; ctx: ClaimContext }[], revs?: Revision[], seen = new Set<string>()): string[] {
  const out: string[] = [];
  for (const { name, ctx } of inputs) {
    const full = claimsOf(ctx, revs);
    for (const m of moved(ctx)) {
      for (const f of claimsOf(m.ctx, revs)) {
        seen.add(f.messageKey);
        const same = full.some((x) => x.messageKey === f.messageKey && x.params?.rule === f.params?.rule && f.lineRefs.every((k) => x.lineRefs.includes(k)));
        if (!same) out.push(`${name}／${m.what} を移すと ${f.messageKey}（${f.lineRefs.join(",")}）が新しく出る`);
      }
    }
  }
  return out;
}

const K1 = loadCase("K1");
const K5 = loadCase("K5");
/**
 * 入力：同梱の症例（症例の JSON の形・UKE から作った形・記録のない形）と、練習問題（明細の 12 問・医師確認の 3 問）。
 * 申告のある種類がどれも 1 回は出るように、同梱の症例に間違いを 1 つ入れた入力を足す（空振りの確認。足すのは、tests/engine/rules/rules.test.ts の「違反あり」と同じ形）
 */
const INPUTS: { name: string; ctx: ClaimContext }[] = [
  ...NAMES.flatMap((n) => [
    { name: n, ctx: loadCase(n) },
    { name: `${n}（UKE）`, ctx: ukeCase(n) },
    { name: `${n}（UKE・記録なし）`, ctx: noRecords(ukeCase(n)) },
  ]),
  ...DRILLS.map((d) => ({ name: `練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  ...DOCTOR_DRILLS.map((d) => ({ name: `医師確認の練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
  // 練習問題の間違いを、記録のない UKE の形に入れたもの（取り込んだ請求で実際に通る道）
  ...DRILLS.map((d) => ({ name: `練習 ${d.id}（UKE・記録なし）`, ctx: noRecords(d.make(ukeCase(nameOf(d.claimId)))) })),
  { name: "K5＋死亡診断加算", ctx: withLines(K5, line("C001_N8_SHIBOU", 1, K5.lines.find((l) => l.kubun === "C001_N7_MITORI")!.dates)) },
  { name: "K1＋対象外の主病の特定疾患処方管理加算", ctx: withFact(withLines(without(K1, "C002_2I1", "C002_N15_RENKEI"), line("F400_N4")), "mainDisease", { known: true, value: "糖尿病" }) },
  { name: "K1＋対象でない患者の緊急往診加算", ctx: withFact(withLines(K1, line("C000", 1, [day(20)]), line("C000_N1_KINKYU", 1, [day(20)])), "emergencyEligible", { known: true, value: false }) },
  { name: "K2＋要介護2", ctx: withFact(withFact(withFact(loadCase("K2"), "careLevel", { known: true, value: 2 }), "disabilitySupportLevel", { known: true, value: 0 }), "table8_3Other", { known: true, value: false }) },
  { name: "K2（UKE）記載を 1 つ消す", ctx: { ...ukeCase("K2"), comments: ukeCase("K2").comments!.slice(1) } },
  { name: "K1（UKE）記載をすべて消す", ctx: { ...ukeCase("K1"), comments: [] } },
  { name: "K1（UKE）壊れた年月日", ctx: { ...ukeCase("K1"), comments: ukeCase("K1").comments!.map((c) => (c.code.startsWith("850") ? commentOf(c.code, "5081332", c.on) : c)) } },
  { name: "K1（UKE）訪問していない日の記載", ctx: { ...ukeCase("K1"), comments: [...ukeCase("K1").comments!, commentOf("850100106", warekiOf(day(30))!, [])] } },
];

describe("申告を縛る：partial で出た指摘は、行を移す前の入力でも同じ行に出ている（design.md §11-11 完了条件 (e)）", () => {
  const seen = new Set<string>();
  const bad = violations(INPUTS, undefined, seen);

  it("同梱の症例と練習問題の入力から、行を 1 行ずつ・1 区分ずつ対象外に移しても、新しい指摘は出ない", () => {
    expect(bad).toEqual([]);
  });

  it("空振りしていない：行を移した入力で、申告のある種類がどれも 1 回は出ている。申告のない種類は 1 回も出ていない", () => {
    const declared = rulesOf(YM).flatMap((r) => r.soundWhenPartial.map((k) => `${r.id}.${k}`));
    expect([...seen].sort()).toEqual([...declared].sort());
    expect(declared.sort()).toEqual([
      "R04.only_main",
      "R05.bundled",
      "R06.excluded_disease",
      "R09.mitori_with_shibou",
      "R12.same_month",
      "R17.comment_format",
      "R17.comment_missing",
    ]);
  });

  it("空振りしていない：ほかの行の回数で決まる指摘（R01 の区分・R11 の判断料・R17 の日付の突き合わせ）を申告すると、この検査に掛かる", () => {
    const declare = (ruleId: string, kinds: string[]): Revision[] =>
      REVISIONS.map((rev) => ({ ...rev, rules: rev.rules.map((r) => (r.id === ruleId ? { ...r, soundWhenPartial: [...r.soundWhenPartial, ...kinds] } : r)) }));
    expect(violations(INPUTS, declare("R01", ["no_visit", "use_once"])).length).toBeGreaterThan(0);
    expect(violations(INPUTS, declare("R11", ["bnp_is_biochem2"])).length).toBeGreaterThan(0);
    expect(violations(INPUTS, declare("R17", ["comment_mismatch_visitDates"])).length).toBeGreaterThan(0);
  });
});

describe("申告しなかった種類（design.md §11-11 の一覧にあるが、行を移すと新しく出る）：申告すると、この検査に掛かる", () => {
  const declare = (ruleId: string, kind: string): Revision[] => REVISIONS.map((rev) => ({ ...rev, rules: rev.rules.map((r) => (r.id === ruleId ? { ...r, soundWhenPartial: [...r.soundWhenPartial, kind] } : r)) }));
  const no = { known: true as const, value: false };
  const visit = K1.lines.find((l) => l.kubun === "C001_1I")!;
  /** 移す前の入力で、その行に何か（指摘か情報不足）が出ているか */
  const flaggedBefore = (c: ClaimContext, ruleIds: string[], kubun: string) => evaluate(c).findings.filter((f) => ruleIds.includes(f.ruleId) && f.lineRefs.includes(kubun)).map((f) => (f.kind === "情報不足" ? `${f.ruleId}:情報不足:${f.missing?.field}` : f.messageKey));

  it("R03.not_eligible：重症で月 2 回以上の月は R02 が同じ加算の行を背反と言い、R03 は黙る。訪問診療料の行が 1 つ対象外に移ると R03 が出る", () => {
    // K1（重症・訪問診療料 2 回）の訪問診療料を 2 行に分け、対象でない患者に包括的支援加算を立てる
    const lines = [...K1.lines.filter((l) => l.kubun !== "C001_1I"), ...visit.dates.map((d) => line("C001_1I", 1, [d])), line("C002_N10_HOKATSU", 1, [visit.dates[0]])];
    const c = withFact(withFact(withFact({ ...K1, lines }, "careLevel", { known: true, value: 2 }), "disabilitySupportLevel", { known: true, value: 0 }), "table8_3Other", no);
    expect(violations([{ name: "重症＋加算", ctx: c }])).toEqual([]);
    const bad = violations([{ name: "重症＋加算", ctx: c }], declare("R03", "not_eligible"));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((b) => b.includes("R03.not_eligible（C002_N10_HOKATSU）"))).toBe(true);
    expect(flaggedBefore(c, ["R02", "R03"], "C002_N10_HOKATSU")).toEqual(["R02.severe_with_hokatsu"]);
  });

  it("R10.kinkyu_not_eligible：同じ日の訪問診療料があって文書提供が不明のあいだ、R10 は情報不足で止まる。訪問診療料の行が対象外に移ると、緊急往診加算の指摘が出る", () => {
    const d = visit.dates[0];
    const c = withFact(withFact(withFact(withLines(K1, line("C000", 1, [d]), line("C000_N1_KINKYU", 1, [d])), "emergencyEligible", no), "sameDayOushinAfterVisit", { known: true, value: { [d]: true } }), "contactDocProvided", { known: false });
    expect(violations([{ name: "緊急往診加算", ctx: c }])).toEqual([]);
    const bad = violations([{ name: "緊急往診加算", ctx: c }], declare("R10", "kinkyu_not_eligible"));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((b) => b.includes("R10.kinkyu_not_eligible（C000_N1_KINKYU）"))).toBe(true);
    expect(flaggedBefore(c, ["R10"], "C000_N1_KINKYU")).toEqual(["R10:情報不足:contactDocProvided"]);
  });
});

describe("partial の請求の判定（design.md §11-11 完了条件 (f)・§11-13 完了条件 (d)）", () => {
  it("合計は出さず（total は null）、点検した行の小計を別に返す。partial でない請求は小計を持たない", () => {
    for (const n of NAMES) {
      const c = loadCase(n);
      const [whole, part] = [evaluate(c), evaluate({ ...c, partial: true })];
      expect(part.total, n).toBeNull();
      expect(part.subtotal, n).toBe(whole.total);
      expect("subtotal" in whole, n).toBe(false);
      expect([part.byLine, part.applied], n).toEqual([whole.byLine, whole.applied]);
    }
  });

  it("申告のない種類の指摘は捨て、捨てた指摘があったルールごとに情報不足（unsupportedLines。宛先は医療事務）を 1 件返す。文言は入力を求めない", () => {
    // 訪問診療料の行が対象外にある（と見立てた）K1：管理料はあるが訪問診療料がない。R01 の「訪問診療料のない月」は言えない
    const c = { ...without(K1, "C001_1I"), partial: true };
    const r01 = evaluate(c).findings.filter((f) => f.ruleId === "R01");
    expect(r01).toEqual([{ ruleId: "R01", kind: "情報不足", lineRefs: ["C002_2I1"], missing: { target: "clerk", field: "unsupportedLines" }, messageKey: "R01.missing_fact", reference: expect.any(String) }]);
    expect(findingText(r01[0])).toBe("この請求には点検の対象外の行があるため、決められません");
    // 同じ行のまま partial でなければ、今までどおり指摘になる
    expect(evaluate({ ...c, partial: false }).findings.filter((f) => f.ruleId === "R01").map(keyOf)).toEqual(["no_visit"]);
    // 捨てた指摘のないルールには付かない
    expect(evaluate({ ...K1, partial: true }).findings.filter((f) => f.missing?.field === "unsupportedLines")).toEqual([]);
  });

  it("申告のある種類はそのまま出る（2 つの行が両方あることだけで言える背反）", () => {
    const c = { ...withLines(K1, line("B000")), partial: true };
    expect(evaluate(c).findings.filter((f) => f.ruleId === "R05").map(keyOf)).toEqual(["bundled"]);
  });

  it("R17：partial では、訪問日の突き合わせ（visitDates）を比べない。必ず要る記載の記載もれと形式は出る（§11-13 完了条件 (d)）", () => {
    const k1 = ukeCase("K1");
    const tags = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R17").map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : `${keyOf(f)}:${f.params?.rule}`));
    // 訪問していない日の記載が 1 件多い：全部の行がある請求では食い違い。対象外の行がある請求では、その日の訪問の行が対象外にあるかもしれないので、比べない
    const extra = { ...k1, comments: [...k1.comments!, commentOf("850100106", warekiOf(day(30))!, [])] };
    expect(tags(extra)).toEqual(["comment_mismatch_visitDates:T176-date"]);
    expect(tags({ ...extra, partial: true })).toEqual(["情報不足:unsupportedLines"]);
    // 必ず要る記載がない・形式が違う：partial でも出る
    expect(tags({ ...k1, comments: [], partial: true })).toEqual(expect.arrayContaining(["comment_missing:T176-date"]));
    const broken = { ...k1, comments: k1.comments!.map((x) => (x.code === "850100106" ? commentOf(x.code, "5081332", x.on) : x)), partial: true };
    expect(tags(broken)).toContain("comment_format:T176-date");
  });

  it("R17：条件つきの記載（同じ日の往診の理由）の記載もれは、partial では指摘にせず、決められないと返す", () => {
    // 訪問診療料と同じ日の往診料があり、理由の記載がない
    const visit = K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0];
    const base: ClaimContext = { ...withLines(ukeCase("K1"), line("C000", 1, [visit])), comments: ukeCase("K1").comments };
    const r17 = (c: ClaimContext) => evaluate(c).findings.filter((f) => f.ruleId === "R17").map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : `${keyOf(f)}:${f.params?.rule}`));
    expect(r17(base)).toEqual(["comment_missing:T162-reason"]);
    expect(r17({ ...base, partial: true })).toEqual(["情報不足:unsupportedLines"]);
  });
});
