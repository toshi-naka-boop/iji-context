// 事務長レポートの「見逃し」（FR-58）：査定・返戻の突き合わせ（I-1）の判定の記録から数える。記録がなければ数えない
import { describe, expect, it } from "vitest";
import { missedOf } from "../../src/prevented/prevented";
import { reportOf, type ReportItem } from "../../src/review/report";

const item = (receiptKey: string, judgments: ReportItem["judgments"], pending: ReportItem["pending"] = null): ReportItem => ({ kind: "zogen", receiptKey, excluded: null, pending, jiyu: ["D"], points: -100, judgments });
const j = (fingerprint: string, result: ReportItem["judgments"][number]["result"]): ReportItem["judgments"][number] => ({ fingerprint, revisionId: "r8", result, reason: result === "同じ論点で指摘していた" ? null : "その他", certainty: result === "同じ論点で指摘していた" ? "確定" : null });

describe("見逃しの数え方", () => {
  it("突き合わせの記録がなければ、件数を出さない（0 件と言わない）", () => {
    expect(missedOf({ ...reportOf([], []), fingerprint: "fp1" })).toEqual({ counted: false });
  });

  it("取り込んでも判定していなければ、数えない", () => {
    expect(missedOf({ ...reportOf([item("a:1", [])], ["fp1"]), fingerprint: "fp1" })).toEqual({ counted: false });
  });

  it("今の点検のコードの回で、同じ論点で指摘していなかった明細（別の論点・指摘なし）を数え、まだ判定していない明細の件数を添える", () => {
    const items = [
      item("a:1", [j("fp1", "同じ論点で指摘していた")]),
      item("a:2", [j("fp1", "別の論点で指摘していた")]),
      item("a:3", [j("fp1", "指摘なし")]),
      item("a:4", []),
      item("a:5", [], "unconfirmed"),
    ];
    expect(missedOf({ ...reportOf(items, ["fp1"]), fingerprint: "fp1" })).toEqual({ counted: true, missed: 2, judged: 3, notYet: 2 });
  });

  it("前の点検のコードの判定だけなら、今の回は数えない", () => {
    const items = [item("a:1", [j("fp0", "指摘なし")])];
    expect(missedOf({ ...reportOf(items, ["fp0"]), fingerprint: "fp1" })).toEqual({ counted: false });
  });
});
