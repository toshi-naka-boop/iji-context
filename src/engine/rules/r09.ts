// R09 死亡診断加算と看取り加算は併算定不可。ターミナルケア加算は死亡日前の所定の日数以内に所定の回数以上の訪問か、退院時共同指導料1 の算定と訪問診療（design.md §11-5）
import { terminalVisitsOk } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, has, present } from "./util";

export function makeR09(c: RevisionConsts): Rule {
  const { mitori: MITORI, shibou: SHIBOU } = c.terminal;
  /** 在宅ターミナルケア加算の、種別ごとの区分の全部（design.md §15-4。X-135）。種別が合っているかは R18 の担当 */
  const TERMINALS = Object.values(c.terminal.terminal);
  return {
    id: "R09",
    kubun: [MITORI, SHIBOU, ...TERMINALS],
    reference: "C001 注6・注7・注8",
    // 回数は訪問・往診・死亡の出来事で数える（看取りと死亡診断の背反 mitori_with_shibou は行だけで決まる）
    recordFindings: ["terminal_visits"],
    soundWhenPartial: ["mitori_with_shibou"],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    // 看取り加算と死亡診断加算の組（注8。電子点数表では同一月内の背反）。在宅ターミナルケア加算の回数（terminal_visits）は、表に載らないので申告しない
    covers: () => ({ kind: "背反", finding: "mitori_with_shibou", kubun: [[MITORI, SHIBOU]] }),
    appliesTo: (ctx) => [MITORI, SHIBOU, ...TERMINALS].some((k) => has(ctx, k)),
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      if (has(ctx, MITORI) && has(ctx, SHIBOU)) out.push(finding(this, "背反", [MITORI, SHIBOU], "mitori_with_shibou"));
      const terminal = present(ctx, TERMINALS);
      if (terminal.length) {
        const visits = terminalVisitsOk(ctx, c);
        if (visits.ok === false) out.push(finding(this, "要件不足", terminal, "terminal_visits"));
        // 同じ日の訪問診療と往診が別々の診療かで回数が変わるときは、その日ごとに情報不足を返す（日付ごとの事実なので needs では扱えない。R10 と同じ形）
        if (visits.ok === "unknown") {
          for (const d of visits.ask)
            out.push({ ruleId: this.id, kind: "情報不足", lineRefs: terminal, missing: { target: "clerk", field: "sameDaySeparate", date: d }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
          // 回数が足りず、訪問診療はある：退院時共同指導料1 を算定していれば満たすので、要件不足と断定しない（needs に入れると看取りと死亡診断の背反まで止まるので、ここで返す）
          if (visits.askGuidance)
            out.push({ ruleId: this.id, kind: "情報不足", lineRefs: terminal, missing: { target: "clerk", field: "dischargeJointGuidance" }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
        }
      }
      return out;
    },
  };
}
