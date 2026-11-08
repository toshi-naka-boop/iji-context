// R09 死亡診断加算と看取り加算は併算定不可。ターミナルケア加算は死亡日前 14 日以内に 2 回以上の訪問
import type { Finding, Rule } from "../types";
import { addDays, eventsOf, finding, has } from "./util";

export const r09: Rule = {
  id: "R09",
  kubun: ["C001_N7_MITORI", "C001_N8_SHIBOU", "C001_N6_TERMINAL"],
  reference: "C001 注6・注7・注8",
  appliesTo: (ctx) => ["C001_N7_MITORI", "C001_N8_SHIBOU", "C001_N6_TERMINAL"].some((k) => has(ctx, k)),
  needs: () => [],
  check(ctx) {
    const out: Finding[] = [];
    if (has(ctx, "C001_N7_MITORI") && has(ctx, "C001_N8_SHIBOU"))
      out.push(finding(this, "背反", ["C001_N7_MITORI", "C001_N8_SHIBOU"], "mitori_with_shibou"));
    if (has(ctx, "C001_N6_TERMINAL")) {
      const death = eventsOf(ctx, "death")[0];
      const from = death ? addDays(death.date, -14) : null;
      const n = death
        ? ctx.events.filter((e) => (e.type === "visit" || e.type === "oushin") && e.date >= from! && e.date <= death.date).length
        : 0;
      if (n < 2) out.push(finding(this, "要件不足", ["C001_N6_TERMINAL"], "terminal_visits"));
    }
    return out;
  },
};
