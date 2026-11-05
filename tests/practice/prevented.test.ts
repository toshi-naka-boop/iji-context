// F9 防いだ額（spec FR-52〜58）
import { describe, expect, it } from "vitest";
import { checkDraft, confirm, startQuestion } from "../../src/practice/practice";
import { managerReport, personalView, preventedOf, summarize } from "../../src/prevented/prevented";
import { line, loadCase, withLines, without } from "../engine/helpers";

const T = "2025-03-10T09:00:00+09:00";

describe("防いだ項目の数え方", () => {
  it("取りこぼし：K2 で包括的支援加算と在宅移行早期加算の取り忘れを指摘され、足して確定 → 250 点", () => {
    const k2 = loadCase("K2");
    let q = startQuestion("q", "c1", k2.claimId, T);
    q = checkDraft(q, without(k2, "C002_N10_HOKATSU", "C002_N4_IKOU"), T).question;
    q = confirm(q, k2, T);
    const items = preventedOf(q);
    expect(items.map((i) => [i.ruleId, i.kind, i.points]).sort()).toEqual([["R03", "取りこぼし", 150], ["R14", "取りこぼし", 100]]);
    expect(summarize(items)).toEqual({ label: "推定", 取りこぼし: { count: 2, yen: 2500 }, 差し戻し: { count: 0, yen: 0 }, 医師記載起因: { count: 0 } });
  });

  it("差し戻し：K1 で処方箋料を立てて背反と指摘され、外して確定 → 60 点", () => {
    const k1 = loadCase("K1");
    let q = startQuestion("q", "c1", k1.claimId, T);
    q = checkDraft(q, withLines(k1, line("F400_3", 1, ["2025-03-26"])), T).question;
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

  it("医師記載起因：医師あての情報不足が医師確認で解決したものは別に件数だけ数える", () => {
    const k1 = loadCase("K1");
    const unknown = { ...k1, facts: { ...k1.facts, table8_2: { known: false as const } } };
    let q = startQuestion("q", "c1", k1.claimId, T);
    q = checkDraft(q, unknown, T).question;
    q = confirm(q, k1, T);
    expect(preventedOf(q, ["table8_2"]).map((i) => i.kind)).toEqual(["医師記載起因"]);
    expect(preventedOf(q, [])).toEqual([]);
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
    const r = managerReport([], [{ claimId: k6.claimId, kubun: ["D008_18"], lines: k6.lines }]);
    expect(r.見逃し).toEqual({ count: 1, yen: 1300 });
    expect(r.label).toBe("推定");
  });
});
