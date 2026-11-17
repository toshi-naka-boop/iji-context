// R09 死亡診断加算と看取り加算は併算定不可。ターミナルケア加算は死亡日前の所定の日数以内に所定の回数以上の訪問
import { terminalVisitsOk } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, has } from "./util";

export function makeR09(c: RevisionConsts): Rule {
  const { mitori: MITORI, shibou: SHIBOU, terminal: TERMINAL } = c.terminal;
  return {
    id: "R09",
    kubun: [MITORI, SHIBOU, TERMINAL],
    reference: "C001 注6・注7・注8",
    appliesTo: (ctx) => [MITORI, SHIBOU, TERMINAL].some((k) => has(ctx, k)),
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      if (has(ctx, MITORI) && has(ctx, SHIBOU)) out.push(finding(this, "背反", [MITORI, SHIBOU], "mitori_with_shibou"));
      if (has(ctx, TERMINAL) && !terminalVisitsOk(ctx, c)) out.push(finding(this, "要件不足", [TERMINAL], "terminal_visits"));
      return out;
    },
  };
}
