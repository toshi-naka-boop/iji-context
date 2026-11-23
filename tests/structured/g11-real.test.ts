// 段 19b（design.md §16-3）を実データの masters.db で：構造化データとの突き合わせを掛けた G11 の候補。RESEMEN_MASTER_DIR があるときだけ動く（ないときは飛ばした数を出す）
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StructuredChart } from "../../src/connect/types";
import { evaluateG11, type G11Result } from "../../src/generic/g11";
import { openMasters } from "../../src/masters/db";
import { withStructured } from "../../src/structured/g11-input";
import { ORDER_MISSING } from "../../src/structured/overlap";
import { aboutOf, rev, ukeClaimOf, without } from "../generic/g11-helpers";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
let skipped = 0;
const withData = (name: string, fn: () => void) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};
afterAll(() => {
  if (!has) process.stderr.write(`段 19b の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});
const UNS = { status: "unsupported" as const };
const INJ = "130000510";

describe("段 19b：実データで G11 に構造化データを掛ける（K8 の皮内、皮下及び筋肉内注射）", () => {
  withData("請求から外した注射は、注射・処置を受け取っている月（0 件）は「文章にあるがオーダーにない」を添えた候補、unsupported の月は添え書きなしの候補", () => {
    const db = openMasters(file)!;
    try {
      const claim = without(ukeClaimOf("K8"), INJ);
      const run = (chart: StructuredChart) => {
        const about = aboutOf("K8");
        const r = evaluateG11(claim, db, { ...about, acts: withStructured(about.acts, { chart, items: [] }, rev).acts }, rev) as Extract<G11Result, { findings: unknown }>;
        return r.findings.find((f) => f.codes.includes(INJ))!;
      };
      const on = run({ visits: UNS, orders: UNS, procedures: { status: "supported", items: [], gaps: {} }, homeCare: UNS });
      expect(on.days.flatMap((d) => d.notes.map((n) => n.text))).toContain(ORDER_MISSING);
      expect(on.caution).toBe(true);
      const off = run({ visits: UNS, orders: UNS, procedures: UNS, homeCare: UNS });
      expect(off.days.flatMap((d) => d.notes.map((n) => n.text))).not.toContain(ORDER_MISSING);
    } finally {
      db.close();
    }
  });
});
