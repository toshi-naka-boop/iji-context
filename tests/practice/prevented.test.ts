// F9 防いだ額（spec FR-52〜58）
import { describe, expect, it } from "vitest";
import { checkDraft, confirm, startQuestion } from "../../src/practice/practice";
import { managerReport, personalView, preventedOf, summarize } from "../../src/prevented/prevented";
import { loadSources } from "../../scripts/gen-uke";
import type { ClaimContext } from "../../src/engine/types";
import { commentsOfCase } from "../../src/uke/cases";
import { line, loadCase, withLines, without } from "../engine/helpers";
import { at, day } from "../helpers/period";

const T = at(12);

describe("防いだ項目の数え方", () => {
  it("取りこぼし：K2 で包括的支援加算と在宅移行早期加算の取り忘れを指摘され、足して確定 → 250 点", () => {
    const k2 = loadCase("K2");
    let q = startQuestion("q", "c1", k2.claimId, T);
    q = checkDraft(q, without(k2, "C002_N10_HOKATSU", "C002_N4_IKOU"), T).question;
    q = confirm(q, k2, T);
    const items = preventedOf(q);
    expect(items.map((i) => [i.ruleId, i.kind, i.points]).sort()).toEqual([["R03", "取りこぼし", 150], ["R14", "取りこぼし", 100]]);
    expect(summarize(items)).toEqual({ label: "推定", 取りこぼし: { count: 2, yen: 2500 }, 差し戻し: { count: 0, yen: 0 }, 医師記載起因: { count: 0, yen: 0 }, 記載もれ: { count: 0 } });
  });

  it("記載もれ：点数を付けず、金額の合計に入れず、件数だけを別に返す。同じ行のほかの指摘の点数も奪わない", () => {
    // 包括的支援加算の取り忘れと、摘要欄の記載もれ（管理料の往診・訪問診療の年月日）を、下書きで指摘されて直した
    const k2: ClaimContext = { ...loadCase("K2"), commentsKnown: true, comments: commentsOfCase(loadCase("K2"), loadSources().src.commentValues?.[loadCase("K2").claimId]) };
    let q = startQuestion("q", "c1", k2.claimId, T);
    const draft = checkDraft(q, { ...without(k2, "C002_N10_HOKATSU"), comments: k2.comments!.filter((c) => c.code !== "850100106" && c.code !== "820100626") }, T);
    expect(draft.result.findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "取り忘れ"], ["R17", "記載もれ"]]);
    q = confirm(draft.question, k2, T);
    const items = preventedOf(q);
    expect(items.map((i) => [i.ruleId, i.kind, i.points]).sort()).toEqual([["R03", "取りこぼし", 150], ["R17", "記載もれ", 0]]);
    expect(summarize(items)).toEqual({ label: "推定", 取りこぼし: { count: 1, yen: 1500 }, 差し戻し: { count: 0, yen: 0 }, 医師記載起因: { count: 0, yen: 0 }, 記載もれ: { count: 1 } });
  });

  it("差し戻し：K1 で処方箋料を立てて背反と指摘され、外して確定 → 60 点", () => {
    const k1 = loadCase("K1");
    let q = startQuestion("q", "c1", k1.claimId, T);
    q = checkDraft(q, withLines(k1, line("F400_3", 1, [day(28)])), T).question;
    q = confirm(q, k1, T);
    expect(preventedOf(q).map((i) => [i.ruleId, i.kind, i.points])).toEqual([["R05", "差し戻し", 60]]);
  });

  it("直さずに確定した指摘・指摘のない修正・下書きなしは数えない（自己申告は数えない）", () => {
    const k2 = loadCase("K2");
    const broken = without(k2, "C002_N10_HOKATSU");
    let q = startQuestion("q", "c1", k2.claimId, T);
    q = checkDraft(q, broken, T).question;
    expect(preventedOf(confirm(q, broken, T))).toEqual([]);
    expect(preventedOf(confirm(startQuestion("p", "c1", k2.claimId, T), k2, T))).toEqual([]);
  });

  it("区分の取り違え：K1 で重症区分を 3,685 点で立て、指摘されて 4,585 点に直した → 取りこぼしを防いだ 900 点（差額）", () => {
    const k1 = loadCase("K1");
    const wrong = withLines(without(k1, "C002_2I1"), line("C002_2RO1", 1, [day(28)]));
    let q = startQuestion("q", "c1", k1.claimId, T);
    q = checkDraft(q, wrong, T).question;
    q = confirm(q, k1, T);
    expect(preventedOf(q).map((i) => [i.ruleId, i.kind, i.points])).toEqual([["R02", "取りこぼし", 900]]);
  });

  it("医師記載起因：在宅酸素の重症度がカルテになく、医師確認で重症と分かって 4,585 点で算定できた → 900 点を医師記載起因に数える（件数と金額）", () => {
    const k1 = loadCase("K1");
    const draft = withLines(without({ ...k1, facts: { ...k1.facts, table8_2: { known: false as const } } }, "C002_2I1"), line("C002_2RO1", 1, [day(28)]));
    let q = startQuestion("q", "c1", k1.claimId, T);
    q = checkDraft(q, draft, T).question;
    q = confirm(q, k1, T);
    const items = preventedOf(q, ["table8_2"]);
    expect(items.map((i) => [i.kind, i.points])).toEqual([["医師記載起因", 900]]);
    expect(summarize(items).医師記載起因).toEqual({ count: 1, yen: 9000 });
    expect(preventedOf(q, []).some((i) => i.kind === "医師記載起因")).toBe(false);
  });
});

describe("表示（FR-56〜58）", () => {
  it("本人向けは既定で非表示。トグルで開くと「推定」付き。見逃した額は本人向けに出ない", () => {
    expect(personalView([], false)).toEqual({ visible: false });
    const v = personalView([], true);
    expect(v).toMatchObject({ visible: true, summary: { label: "推定" } });
    expect(JSON.stringify(v)).not.toContain("見逃し");
  });

  it("事務長向けにだけ見逃した額（返戻・査定になった行）を集計で出す", () => {
    const k6 = loadCase("K6");
    const r = managerReport([], [{ claimId: k6.claimId, kubun: ["D008_19"], lines: k6.lines }]);
    expect(r.見逃し).toEqual({ count: 1, yen: 1300 });
    expect(r.label).toBe("推定");
  });
});
