// データで動く点検の結果を、画面に出す形にする（design.md §12-5）：指摘の文（定型文）、当たる行の名称、出どころ、点検の範囲（動いた点検・動かさなかった点検と理由）
import { genericNotRunText, genericText } from "../messages";
import type { RowNames } from "./lookup";
import type { GenericScope } from "./scope";
import type { GenericResult } from "./types";

export type GenericView = {
  findings: { check: string; kind: string; certainty: "確定" | "条件つき"; text: string; codes: { code: string; name: string | null }[]; source: { data: string; ref: string } }[];
  /** 動いた点検。「指摘なし」は、ここにある点検についてだけ言える */
  ran: { check: string; kind: string }[];
  /** 動かさなかった点検と理由。reason は、データがない（noMasters・noSnapshot）／準備ができていない（notReady）／まだ入っていない（notBuilt） */
  notRun: { check: string; kind: string; reason: string; text: string }[];
  /** 上限（FINDING_LIMIT）を超えたので返さなかった指摘の数（点検ごと）。画面は「ほか N 件」と出す */
  omitted: { check: string; kind: string; count: number }[];
  /** 検算（G02）の数と対象外の理由、G02・G03 が点検していないこと（src/generic/scope.ts。呼び出し側が足す） */
  scope?: GenericScope;
};

/** names は、行の名称（マスターがなければ null）。持っているマスターにないコードは、指摘の値（params.name）にある名称を添える */
export function genericView(result: GenericResult, names: RowNames | null): GenericView {
  return {
    findings: result.findings.map((f) => ({
      check: f.check,
      kind: f.kind,
      certainty: f.certainty,
      text: genericText(f),
      codes: f.codes.map((code) => ({ code, name: names?.items[code]?.name ?? f.params.name ?? null })),
      source: f.source,
    })),
    ran: result.ran,
    notRun: result.notRun.map((n) => ({ check: n.check, kind: n.kind, reason: n.reason, text: genericNotRunText(n) })),
    omitted: result.omitted ?? [],
  };
}
