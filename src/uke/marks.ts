// 取り込んだレセプトの画面の、行ごとの手書きのルールの印（design.md §18-3 判断 F。round-82 C-531）：
// 条件つきの指摘（申告のとおりなら。params.conditional）は確定の指摘と分け、「条件つき n」として別に数える
import type { Finding } from "../engine/types";

export function handMarksOf(findings: Pick<Finding, "kind" | "lineRefs" | "params">[], kubun: string[]): { kinds: Record<string, number>; conditional: number } {
  const mine = findings.filter((f) => f.lineRefs.some((k) => kubun.includes(k)));
  const kinds: Record<string, number> = {};
  for (const f of mine.filter((x) => x.params?.conditional !== "1")) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  return { kinds, conditional: mine.filter((x) => x.params?.conditional === "1").length };
}
