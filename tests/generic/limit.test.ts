// round-32 S-9：指摘の数の上限。親子の組で増える包括（G04）・背反（G05）を細工したレセプトで、点検の全体が短い時間・小さなメモリで終わり、返す JSON が小さいこと。
// 反証の細工（同じグループの親と子のコードを、全部同じ算定日に 1 行 1 単位で並べる）を、小さな表で作り直す。実データでの確認は tests/generic/tables-real.test.ts
import { describe, expect, it } from "vitest";
import { evaluateGeneric } from "../../src/generic";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import { FINDING_LIMIT } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { putHaihan, tensuhyoMasters } from "./small-tensuhyo";

const about = { yearMonth: YM, generation: GEN };
const LIVE = { change: "0", created_on: "20100401", abolished_on: "99999999" };
const SNAP = "20261001";
const day1 = Array.from({ length: 31 }, (_, i) => (i === 0 ? 1 : 0));
const claimOf = (codes: string[]): TimedClaim => ({ units: codes.map((code) => ({ items: [{ kind: "SI" as const, code }], count: 1, days: day1 })) });

describe("指摘の数の上限（round-32 S-9）", () => {
  it(`包括：親 150 × 子 3,000（45 万組）を同じ日に並べても、点検ごとに ${FINDING_LIMIT} 件まで返し、残りは数だけ（2 秒以内・JSON は小さい）`, () => {
    const db = tensuhyoMasters(SNAP);
    const parents = Array.from({ length: 150 }, (_, i) => `19${String(i).padStart(7, "0")}`);
    const kids = Array.from({ length: 3000 }, (_, i) => `18${String(i).padStart(7, "0")}`);
    db.transaction(() => {
      for (const code of parents) put(db, "hojo", SNAP, { ...LIVE, code, unit1: "1", group1: "X000001" });
      for (const code of kids) put(db, "houkatsu", SNAP, { ...LIVE, group_no: "X000001", code, tokurei: "0" });
    })();
    const heap = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = evaluateGeneric(claimOf([...parents, ...kids]), db, about);
    const ms = performance.now() - t0;
    const g04 = r.findings.filter((f) => f.check === "G04");
    expect(g04.length).toBe(FINDING_LIMIT);
    expect(r.omitted?.find((o) => o.check === "G04")?.count).toBe(150 * 3000 - FINDING_LIMIT);
    // どの点検も上限を超えない（マスターにないコード〔G01〕も 3,150 個ある）
    for (const id of new Set(r.findings.map((f) => f.check))) expect(r.findings.filter((f) => f.check === id).length, id).toBeLessThanOrEqual(FINDING_LIMIT);
    expect(ms).toBeLessThan(2000);
    expect((process.memoryUsage().heapUsed - heap) / 1e6).toBeLessThan(200);
    const json = JSON.stringify(genericView(r, null));
    expect(json.length).toBeLessThan(1_000_000);
    expect(JSON.parse(json).omitted).toContainEqual({ check: "G04", kind: "包括", count: 150 * 3000 - FINDING_LIMIT });
  });

  it("背反：組の数え上げも、上限に達したら数えるだけにする", () => {
    const db = tensuhyoMasters(SNAP);
    const a = Array.from({ length: 30 }, (_, i) => `17${String(i).padStart(7, "0")}`);
    const b = Array.from({ length: 30 }, (_, i) => `16${String(i).padStart(7, "0")}`);
    db.transaction(() => {
      for (const x of a) for (const y of b) putHaihan(db, SNAP, 2, x, y, "3", "0");
    })();
    const r = evaluateGeneric(claimOf([...a, ...b]), db, about);
    expect(r.findings.filter((f) => f.check === "G05").length).toBe(FINDING_LIMIT);
    expect(r.omitted?.find((o) => o.check === "G05")?.count).toBe(900 - FINDING_LIMIT);
  });

  it("上限に届かない請求は、omitted を持たない（数は 0 件として出さない）", () => {
    const r = evaluateGeneric(claimOf(["114001110"]), tensuhyoMasters(SNAP), about);
    expect(r.omitted ?? []).toEqual([]);
  });
});
