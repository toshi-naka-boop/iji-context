// 取り忘れ G11 と HX-25（design.md §19-13 の 3）：G12・G05 と同じ事実（前の月の管理料の三値と算定日の前後。homeOxygenSettled）で、K10 の酸素吸入の強さが揃う。
// RESEMEN_MASTER_DIR があるときだけ動く
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateG11, type G11Result } from "../../src/generic/g11";
import { openMasters } from "../../src/masters/db";
import { aboutOf, prevHomeOxygenOf, rev, ukeClaimOf } from "./g11-helpers";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const run = (prev: "ある" | "ない" | "取り込んでいない") => {
  const db = openMasters(file)!;
  try {
    return evaluateG11(ukeClaimOf("K10"), db, aboutOf("K10", { prevHomeOxygen: prev }), rev) as Extract<G11Result, { findings: unknown }>;
  } finally {
    db.close();
  }
};
const J024 = "140005610";

describe("K10 の酸素吸入（G11 と HX-25）", () => {
  it.skipIf(!has)("合成データの前の月（2026-09）に管理料があるので「ある」と読み、酸素吸入は背反として言わなかった一覧に並ぶ", () => {
    expect(prevHomeOxygenOf("K10")).toBe("ある");
    const r = run("ある");
    expect(r.findings.filter((f) => f.codes.includes(J024))).toEqual([]);
    expect(r.hidden.some((h) => h.reason === "背反" && h.written === "酸素吸入")).toBe(true);
  });

  it.skipIf(!has)("前の月を取り込んでいない（・管理料がない）ときは、導入の月かもしれないので注意つきの候補になる（U-79）", () => {
    for (const prev of ["取り込んでいない", "ない"] as const) {
      const fs = run(prev).findings.filter((f) => f.codes.includes(J024));
      expect([prev, fs.map((f) => f.caution === true)]).toEqual([prev, [true]]);
    }
  });
});
