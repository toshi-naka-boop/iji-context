// design.md §11-6・§11-8 完了条件 10：カルテ側の記録がない請求（recordsKnown が偽）では、出来事を読んで決める指摘を出さず、情報不足（chartRecord）を返す。
// 行だけで決まる指摘はそのまま出る。どの指摘が出来事を読むかは、ルールの recordFindings の申告で決まり、その申告をここで縛る
import { describe, expect, it } from "vitest";
import { evaluate, rulesOf } from "../../src/engine";
import type { ClaimContext, Finding } from "../../src/engine/types";
import { findingText } from "../../src/messages";
import { DRILLS } from "../../src/practice/drills";
import { day, YM } from "../helpers/period";
import { line, loadCase, withLines, without } from "./helpers";

const NAMES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const K1 = loadCase("K1");
const K2 = loadCase("K2");
const K5 = loadCase("K5");

/** 同じ行と事実のまま、カルテ側の記録（出来事）がない請求にする */
const noRecords = (c: ClaimContext): ClaimContext => ({ ...c, events: [], recordsKnown: false });
/** 指摘の種類（messageKey の「ルール id.」より後ろ） */
const keyOf = (f: Finding) => f.messageKey.slice(f.ruleId.length + 1);
const of = (c: ClaimContext, ruleId: string) => evaluate(c).findings.filter((f) => f.ruleId === ruleId);
/** 「種類」か、情報不足なら「情報不足:足りない項目」 */
const tags = (c: ClaimContext, ruleId: string) => of(c, ruleId).map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing?.field}` : keyOf(f)));

describe("記録のない請求：出来事を読んで決める指摘は出ず、chartRecord の情報不足になる", () => {
  it("R09：ターミナルケア加算の回数（terminal_visits）は出ない。記録を付けた同じ請求は今までどおり指摘なし", () => {
    expect(of(noRecords(K5), "R09")).toEqual([
      { ruleId: "R09", kind: "情報不足", lineRefs: ["C001_N7_MITORI", "C001_N6_TERMINAL"], missing: { target: "clerk", field: "chartRecord" }, messageKey: "R09.missing_fact", reference: expect.any(String) },
    ]);
    expect(of(K5, "R09")).toEqual([]);
    // 出来事が空でも、記録はあると分かっている請求なら、空の出来事を「なかった」と読む（今までどおり）
    expect(tags({ ...K5, events: [] }, "R09")).toEqual(["terminal_visits"]);
  });
  it("R14：在宅移行早期加算（not_eligible・missing）は出ない", () => {
    expect(tags(noRecords(K2), "R14")).toEqual(["情報不足:chartRecord"]);
    expect(tags({ ...K2, events: [] }, "R14")).toEqual(["not_eligible"]);
    expect(tags(K2, "R14")).toEqual([]);
  });
  it("R07：処方箋料の区分は、処方の記録がないので決めない（rxRecord も出さず、chartRecord の 1 件だけ）", () => {
    const c = withLines(without(K1, "C002_2I1", "C002_N15_RENKEI"), line("F400_2", 1, [day(28)]));
    expect(tags(noRecords(c), "R07")).toEqual(["情報不足:chartRecord"]);
    expect(tags({ ...c, events: [] }, "R07")).toEqual(["情報不足:rxRecord"]);
  });
  it("合計・行ごとの点数・当たったルールは、記録の有無で変わらない", () => {
    for (const name of NAMES) {
      const c = loadCase(name);
      const [a, b] = [evaluate(c), evaluate(noRecords(c))];
      expect([b.total, b.byLine, b.applied]).toEqual([a.total, a.byLine, a.applied]);
    }
  });
  it("chartRecord が付くのは、出来事を読む指摘を持つルールが当たったときだけ。1 つのルールに 1 件", () => {
    for (const name of NAMES) {
      const c = noRecords(loadCase(name));
      const r = evaluate(c);
      const want = rulesOf(YM).filter((rule) => rule.recordFindings.length > 0 && r.applied.includes(rule.id)).map((rule) => rule.id);
      expect(r.findings.filter((f) => f.missing?.field === "chartRecord").map((f) => f.ruleId), name).toEqual(want);
    }
  });
  it("文言は「記録がない」と伝え、入力を求めない", () => {
    const text = findingText(of(noRecords(K5), "R09")[0]);
    expect(text).toContain("この請求にはカルテ側の記録がありません");
    expect(text).not.toMatch(/入力してください/);
  });
});

describe("記録のない請求でも、行だけで決まる指摘は出る", () => {
  it("管理料と処方箋料（R05 の bundled）", () => {
    const c = withLines(K1, line("F400_3", 1, [day(28)]), line("F400_N4", 1, [day(28)]));
    expect(of(noRecords(c), "R05").filter((f) => f.kind !== "情報不足")).toEqual([expect.objectContaining({ kind: "背反", messageKey: "R05.bundled", lineRefs: ["F400_3", "F400_N4"] })]);
    expect(tags(noRecords(c), "R05")).toEqual(["情報不足:chartRecord", "bundled"]);
  });
  it("看取り加算と死亡診断加算（R09 の mitori_with_shibou）", () => {
    const c = withLines(K5, line("C001_N8_SHIBOU", 1, [day(22)]));
    expect(tags(noRecords(c), "R09")).toEqual(["情報不足:chartRecord", "mitori_with_shibou"]);
    expect(tags(c, "R09")).toEqual(["mitori_with_shibou"]);
  });
  it("出来事を読まないルール（R01・R02・R04・R11・R12 など）の指摘は、記録の有無で変わらない", () => {
    const cases = [without(K1, "C001_1I", "O001_3I", "O100_1HA"), withLines(K1, line("C101_2I")), without(K1, "D026_5"), withLines(K1, line("A_DENSHI_RENKEI"))];
    const quiet = rulesOf(YM).filter((r) => r.recordFindings.length === 0).map((r) => r.id);
    for (const c of cases) {
      const pick = (x: ClaimContext) => evaluate(x).findings.filter((f) => quiet.includes(f.ruleId));
      expect(pick(noRecords(c))).toEqual(pick(c));
      expect(pick(c).length).toBeGreaterThan(0);
    }
  });
});

describe("recordFindings の申告（design.md §11-6）", () => {
  /** 同梱の症例と、練習問題の入力（よくある間違いを入れた明細） */
  const inputs: [string, ClaimContext][] = [
    ...NAMES.map((n): [string, ClaimContext] => [n, loadCase(n)]),
    ...DRILLS.map((d): [string, ClaimContext] => [d.id, d.make(loadCase(d.claimId.split("-")[0]))]),
  ];
  it.each(inputs)("%s：出来事を空にすると出て、出来事を足すと消える指摘の種類は、そのルールの recordFindings に載っている", (_name, c) => {
    const withEvents = evaluate(c).findings;
    // 行と事実は同じまま、出来事だけを空にする（記録はあるものとして読ませ、何が出るかを見る）
    const emptied = evaluate({ ...c, events: [] }).findings;
    for (const rule of rulesOf(c.yearMonth)) {
      const kinds = (fs: Finding[]) => new Set(fs.filter((f) => f.ruleId === rule.id).map(keyOf));
      const gone = [...kinds(emptied)].filter((k) => !kinds(withEvents).has(k));
      for (const k of gone) expect(rule.recordFindings, `${rule.id}.${k}`).toContain(k);
    }
  });
  it("この検査が空振りしていない：症例と練習問題の入力で、出来事を空にすると出る指摘が実際にある（R09・R14・R07）", () => {
    const seen = new Set<string>();
    for (const [, c] of inputs) {
      const before = new Set(evaluate(c).findings.map((f) => f.messageKey));
      for (const f of evaluate({ ...c, events: [] }).findings) if (!before.has(f.messageKey)) seen.add(f.messageKey);
    }
    expect([...seen].sort()).toEqual(["R07.no_rx_record", "R09.terminal_visits", "R14.not_eligible"]);
  });
  it("申告した種類は、そのルールが実際に出す指摘の種類（文言があるか、処方の記録の情報不足）", async () => {
    const { FINDING_TEXT } = await import("../../src/messages");
    for (const rule of rulesOf(YM)) for (const k of rule.recordFindings) expect(k === "no_rx_record" || FINDING_TEXT[`${rule.id}.${k}`] !== undefined, `${rule.id}.${k}`).toBe(true);
  });
});
