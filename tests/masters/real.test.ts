// 実データ（masters.db）で確かめるテスト（design.md §12-7）。データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。
// ないときは飛ばし、飛ばした数を表示する（黙って通さない）。作り方は docs/masters.md
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { period } from "../../src/demo/period";
import { r2026 } from "../../src/engine/revisions/r2026";
import { MASTERS_CONFIG } from "../../src/masters/config";
import { iyakuhinOf, openMasters, pickSnapshot, shinryoOf, sourcesOf, tokuteiOf } from "../../src/masters/db";
import { readEm, verifyMasters } from "../../src/masters/verify";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
let skipped = 0;
/** データがあるときだけ動くテスト */
const withData = (name: string, fn: () => void) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};

describe("実データの masters.db", () => {
  const em = readEm(root);

  withData("読み方を確かめた版の件数が、EM §2-11 の件数と合う（基本マスター 6 本・電子点数表・コメント関連テーブル・チェックマスタ）", () => {
    const db = openMasters(file)!;
    const rows = (tbl: string) => sourcesOf(db).filter((s) => s.tbl === tbl && s.snapshot === s.verified).reduce((n, s) => n + s.rows, 0);
    const whole = em.counts.filter((x) => Object.keys(x.where).length === 0 && !x.not);
    for (const c of whole) expect(rows(c.table), c.table).toBe(c.count);
    expect(whole).toHaveLength(14);
    db.close();
  });

  withData("錨が全部通り、値ごとの件数が合い、版の表との食い違いが 0 件", () => {
    const db = openMasters(file)!;
    const r = verifyMasters(db, em, { write: false });
    expect(r.lines.filter((l) => /外れた|件数が違う|食い違う（/.test(l))).toEqual([]);
    expect(r.failures).toBe(0);
    expect(r.lines).toContain("版の表との食い違い：0 件");
    expect(r.lines[0]).toMatch(new RegExp(`^錨：${em.anchors.length} 個のうち ${em.anchors.length} 個が通った`));
    db.close();
  });

  withData("施設基準の組ごとの列（design.md §15-3）：錨 A109〜A116 が通り、組ごとの件数（g1≠0 4,623・g2≠0 900・g3≠0 286）が合う", () => {
    const db = openMasters(file)!;
    const r = verifyMasters(db, em, { write: false });
    expect(em.anchors.filter((a) => /^A1(09|1[0-6])$/.test(a.id))).toHaveLength(8);
    expect(r.lines.filter((l) => /^錨 A1(09|1[0-6]) /.test(l))).toEqual([]);
    const n = (col: string) => (db.prepare(`SELECT count(*) AS n FROM shinryo WHERE snapshot = ? AND ${col} != '0'`).get(em.verified.shinryo) as { n: number }).n;
    expect(["shisetsu_g1", "shisetsu_g2", "shisetsu_g3"].map(n)).toEqual([4623, 900, 286]);
    expect(r.ready.filter((x) => x.check === "G10" || x.check === "G11").map((x) => x.ready)).toEqual([true, true]);
    db.close();
  });

  withData("基準月の 1 枚を選び、コードから行を引ける。版の点数表（EM の採用値）と同じ点数が入っている", () => {
    const db = openMasters(file)!;
    const pick = pickSnapshot(db, "shinryo", period.yearMonth, MASTERS_CONFIG.generation)!;
    expect(pick).not.toBeNull();
    for (const kubun of ["C000", "C001_1I", "A001", "B000"]) {
      const row = shinryoOf(db, pick.snapshot, r2026.codes[kubun].primary)!;
      expect([kubun, row.point_kind, row.points]).toEqual([kubun, "3", r2026.points[kubun].points]);
    }
    expect(shinryoOf(db, pick.snapshot, "100000000")).toBeNull();
    expect(pickSnapshot(db, "shinryo", period.yearMonth, "R6")).toBeNull();
    // 医薬品・特定器材も、その 1 枚から引ける（錨 A22・A23 と同じ行）
    const iy = pickSnapshot(db, "iyakuhin", period.yearMonth, MASTERS_CONFIG.generation)!;
    expect(iyakuhinOf(db, iy.snapshot, "630010002")).toMatchObject({ price_kind: "7", price: 0 });
    const to = pickSnapshot(db, "tokutei", period.yearMonth, MASTERS_CONFIG.generation)!;
    expect(tokuteiOf(db, to.snapshot, "700080000")).toMatchObject({ price_kind: "1", price: 62 });
    db.close();
  });

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    // console は、通ったテストの分を vitest が表示しないことがあるので、標準エラーに直接書く
    if (!has) process.stderr.write(`実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 4);
  });
});
