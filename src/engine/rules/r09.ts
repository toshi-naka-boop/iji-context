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
      if (has(ctx, TERMINAL)) {
        const visits = terminalVisitsOk(ctx, c);
        if (visits.ok === false) out.push(finding(this, "要件不足", [TERMINAL], "terminal_visits"));
        // 同じ日の訪問診療と往診が別々の診療かで回数が変わるときは、その日ごとに情報不足を返す（日付ごとの事実なので needs では扱えない。R10 と同じ形）
        if (visits.ok === "unknown")
          for (const d of visits.ask)
            out.push({ ruleId: this.id, kind: "情報不足", lineRefs: [TERMINAL], missing: { target: "clerk", field: "sameDaySeparate", date: d }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      }
      return out;
    },
  };
}
