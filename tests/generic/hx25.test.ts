// G05 の例外 HX-25（在宅酸素療法の導入の月。HP-35。design.md §19-13 の 3）を、G12 の事実で決める。G12 の 1 と同じ組・同じ条件で、強さが揃う
// データは同梱しないので、小さな表（tests/generic/small-tensuhyo.ts。在宅酸素療法指導管理料 × 酸素吸入は錨 A47・A51 の同一月・特例条件あり）で確かめる
import { describe, expect, it } from "vitest";
import { evaluateGeneric } from "../../src/generic";
import { g05 } from "../../src/generic/g05";
import { g12 } from "../../src/generic/g12";
import type { GenericAboutMore, GenericClaim, GenericUnitDetail } from "../../src/generic/types";
import { YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { C, tensuhyoMasters } from "./small-tensuhyo";

const SMALL = "739230000";
function db() {
  const d = tensuhyoMasters();
  // HP-35 は区分番号で選ぶ（C103 × J024）。M8 の章・部・区分番号（EM §2-8・§2-15 2-3b）を手作りの行に入れる
  const at = (code: string, bu: number, kubun: number) => d.prepare("UPDATE shinryo SET sho = 2, bu = ?, kubun_no = ? WHERE code = ?").run(bu, kubun, code);
  if (!d.prepare("SELECT 1 FROM shinryo WHERE code = ?").get(C.sansoKyunyu)) put(d, "shinryo", "20261001", { code: C.sansoKyunyu, name: "酸素吸入", alpha: "J", point_kind: "3", points: 65 });
  at(C.sanso, 2, 103);
  at(C.sansoKyunyu, 9, 24);
  put(d, "tokutei", "20261001", { code: SMALL, name: "手作りの器材", price_kind: "1", price: 2.36, sanso: "5", changed_on: "20260601" });
  d.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G02', 1, '')").run();
  return d;
}
const unit = (si: string[], days: number[], to: string[] = []): GenericUnitDetail => ({
  points: 1,
  count: days.length,
  days: Array.from({ length: 31 }, (_, d) => (days.includes(d + 1) ? 1 : 0)),
  items: [...si.map((code) => ({ kind: "SI" as const, code })), ...to.map((code) => ({ kind: "TO" as const, code, quantity: "100", unitPrice: "1.80" }))],
});
/** 管理料は kanriDay、酸素吸入と酸素は同じ単位で o2Day */
const claimOf = (kanriDay: number, o2Day: number): GenericClaim => ({ units: [unit([C.sanso], [kanriDay]), unit([C.sansoKyunyu], [o2Day], [SMALL])] });
const about = (more: Partial<GenericAboutMore>): GenericAboutMore => ({ yearMonth: YM, generation: GEN, outpatient: true, ...more });
/** G05 と G12 の、この組の指摘の強さ（言い切りの一覧に G05.exception_none と G12.home_oxygen を載せたとき） */
function strengths(c: GenericClaim, a: GenericAboutMore) {
  const r = evaluateGeneric(c, db(), a, [g05, g12], new Set(["G05.exception_none", "G12.home_oxygen"]));
  return { g05: r.findings.filter((f) => f.check === "G05").map((f) => [f.messageKey, f.certainty]), g12: r.findings.filter((f) => f.check === "G12").map((f) => [f.messageKey, f.certainty]) };
}

describe("HX-25（G05）と G12 の 1 の強さが揃う", () => {
  it("前の月にも管理料があり、酸素吸入の算定日が管理料の算定日以後：G05 は例外に当たらない（言い切りの候補）、G12 も確定", () => {
    expect(strengths(claimOf(1, 10), about({ prevHomeOxygen: "ある" }))).toEqual({ g05: [["G05.exception_none", "確定"]], g12: [["G12.home_oxygen", "確定"]] });
  });

  it("前の月が「ない」「取り込んでいない」・管理料の算定日より前の日（再導入の月）：G05 も G12 も条件つき", () => {
    for (const [c, a] of [
      [claimOf(1, 10), about({ prevHomeOxygen: "ない" })],
      [claimOf(1, 10), about({ prevHomeOxygen: "取り込んでいない" })],
      [claimOf(1, 10), about({})],
      [claimOf(20, 3), about({ prevHomeOxygen: "ある" })],
    ] as const) {
      const s = strengths(c, a);
      expect(s.g05.map(([, x]) => x)).toEqual(["条件つき"]);
      expect(s.g12).toEqual([["G12.home_oxygen_intro", "条件つき"]]);
    }
  });

  it("再導入の月を 1 枚の請求に書いた（管理料 20 日、酸素吸入と酸素 3 日・25 日）：導入前の 3 日は G05・G12 とも条件つき、導入後の 25 日は G05・G12 とも確定（算定日ごと。C-610）", () => {
    const c: GenericClaim = { units: [unit([C.sanso], [20]), unit([C.sansoKyunyu], [3], [SMALL]), unit([C.sansoKyunyu], [25], [SMALL])] };
    const r = evaluateGeneric(c, db(), about({ prevHomeOxygen: "ある" }), [g05, g12], new Set(["G05.exception_none", "G12.home_oxygen"]));
    const g05s = r.findings.filter((f) => f.check === "G05").map((f) => [f.messageKey, f.certainty, f.params.days]);
    const g12s = r.findings.filter((f) => f.check === "G12").map((f) => [f.messageKey, f.certainty, f.units[0]]);
    expect(g05s).toEqual(expect.arrayContaining([["G05.exception_none", "確定", "25"], [expect.stringMatching(/^G05\.exception_/), "条件つき", "3"]]));
    expect(g05s).toHaveLength(2);
    expect(g12s).toEqual([["G12.home_oxygen_intro", "条件つき", 1], ["G12.home_oxygen", "確定", 2]]);
  });

  it("入院のレセプトは HX-20 に当たるので、G05 は出さない", () => {
    expect(strengths(claimOf(1, 10), about({ outpatient: false, prevHomeOxygen: "ある" })).g05).toEqual([]);
  });
});
