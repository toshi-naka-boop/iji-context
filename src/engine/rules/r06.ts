// R06 特定疾患処方管理加算は主病が対象疾患のとき。糖尿病・高血圧・脂質異常症は 2024 年 6 月から対象外。28 日以上の処方
import type { Finding, Rule } from "../types";
import { eventsOf, fact, finding, has } from "./util";

/** 2024 年改定で対象から外れた主病（report-A 項目11 c-2） */
const EXCLUDED = ["糖尿病", "高血圧", "脂質異常症"];

export const r06: Rule = {
  id: "R06",
  kubun: ["F400_N4"],
  reference: "F400 注4 特定疾患処方管理加算",
  appliesTo: (ctx) => has(ctx, "F400_N4"),
  needs: () => ["mainDisease"],
  check(ctx) {
    const out: Finding[] = [];
    const main = fact(ctx, "mainDisease");
    if (EXCLUDED.some((d) => main.includes(d))) out.push(finding(this, "要件不足", ["F400_N4"], "excluded_disease"));
    const rx = eventsOf(ctx, "prescription");
    if (rx.length > 0 && rx.every((e) => e.days < 28)) out.push(finding(this, "要件不足", ["F400_N4"], "under_28_days"));
    return out;
  },
};
