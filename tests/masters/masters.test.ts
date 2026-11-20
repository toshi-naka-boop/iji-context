// 公開データの取り込み（src/masters/。design.md §12-1）。データは同梱しないので、EM に採用済みのコード・点数だけで手で作った数行の表で確かめる（公開元の表の行は写していない）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import iconv from "iconv-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Revision } from "../../src/engine/revisions/types";
import { createSchema, ingestAll } from "../../src/masters/build";
import { MASTERS_CONFIG, snapshotOf } from "../../src/masters/config";
import { MasterFormatError, readCsv } from "../../src/masters/csv";
import { mastersStatus, openMasters, pickSnapshot, shinryoOf } from "../../src/masters/db";
import { LAYOUTS } from "../../src/masters/layout";
import { parseEm, verifyMasters } from "../../src/masters/verify";

const OUSHIN = r2026.codes.C000.primary; // 往診料（EM §2-8）
const KINKYU = r2026.codes.C000_N1_KINKYU.primary; // 緊急往診加算（在支診等）
const HOUMON = r2026.codes.C001_1I.primary; // 在宅患者訪問診療料（１）１（同一建物居住者以外）
const pt = (kubun: string) => r2026.points[kubun].points!;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "resemen-masters-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sjis = (rows: string[][]) => iconv.encode(rows.map((r) => `${r.map((v) => `"${v}"`).join(",")}\r\n`).join(""), "Shift_JIS");

/** 医科診療行為マスターの 1 行（150 項目）。set は項番 → 値 */
function shinryoRow(code: string, name: string, points: number, set: Record<number, string> = {}): string[] {
  const c = Array.from({ length: 150 }, () => "0");
  const base: Record<number, string> = { 2: "S", 3: code, 5: name, 11: "3", 12: points.toFixed(2), 32: "99999999", 34: "0.00", 41: "00", 42: "00", 68: "1", 69: "1", 85: "C", 87: "20260601", 88: "99999999" };
  for (const [n, v] of Object.entries({ ...base, ...set })) c[Number(n) - 1] = v;
  return c;
}
const SHINRYO = [
  shinryoRow(OUSHIN, "往診料", pt("C000"), { 38: "1401" }),
  shinryoRow(KINKYU, "緊急往診加算（在支診等）", pt("C000_N1_KINKYU"), { 38: "1401", 39: "1", 68: "7", 69: "7" }),
  shinryoRow(HOUMON, "在宅患者訪問診療料（１）１（同一建物居住者以外）", pt("C001_1I"), { 13: "2", 27: "2", 28: "2" }),
];
/** 背反関連テーブルの 1 行（10 項目）：往診料と訪問診療料は、同じ日にはいずれか一方。条件あり（EM §2-11 の錨 A46 と同じ事実） */
const HAIHAN = [["0", OUSHIN, "往診料", HOUMON, "訪問診療料", "3", "1", "0", "20100401", "99999999"]];

/** raw の下にファイルを置く */
function put(raw: string, dataset: string, snapshot: string, file: string, bytes: Uint8Array) {
  mkdirSync(path.join(raw, dataset, snapshot), { recursive: true });
  writeFileSync(path.join(raw, dataset, snapshot, file), bytes);
}
function build(raw: string) {
  const db = new Database(":memory:");
  createSchema(db);
  const rejected = ingestAll(db, raw, MASTERS_CONFIG, "2026-11-21T00:00:00.000Z");
  return { db, rejected };
}
const count = (db: Database.Database, table: string, snapshot: string) => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE snapshot = ?`).get(snapshot) as { n: number }).n;

const EM = (anchors: string[], counts: string[], verified = "20261102") =>
  [
    "### 2-8. 採用した診療行為コード",
    `| C000 | ${OUSHIN} | — | 往診料 | 720 | 14 | 高 |  |`,
    "### 2-11. 採用したデータ源",
    "#### 表 1",
    `| \`shinryo\` 医科診療行為マスター | 公開元 | ${verified} | ファイル | 項目 | 仕様書 |`,
    `| \`tensuhyo\` 電子点数表 | 公開元 | ${verified} | ファイル | 項目 | 仕様書 |`,
    "#### 表 2",
    ...anchors,
    "#### 表 3",
    ...counts,
    "## 3. 次の章",
    "| A99 | `shinryo` | `code=1` | `points=1` | 節の外 | — |",
  ].join("\n");

describe("config と layout", () => {
  it("config/masters.json の files は、どれも layout.ts の表を指し、取り込む項番が項目数に収まる", () => {
    for (const ds of Object.values(MASTERS_CONFIG.datasets)) {
      for (const f of ds.files) {
        const layout = LAYOUTS.find((l) => l.id === f.layout);
        expect(layout, f.layout).toBeDefined();
        expect(Math.max(...layout!.columns.flatMap((c) => c.item))).toBeLessThanOrEqual(f.fields);
      }
    }
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(LAYOUTS.length);
  });

  it("更新日を、ファイル名（西暦 8 桁）とリンクの文字（令和）から取り出す", () => {
    expect(snapshotOf("^s_(\\d{8})\\.csv$", "s_20261102.csv")).toBe("20261102");
    expect(snapshotOf("【令和(\\d+)年(\\d+)月(\\d+)日】", "テーブル【令和8年11月2日】")).toBe("20261102");
    expect(snapshotOf("^s_(\\d{8})\\.csv$", "s_2026.csv")).toBeNull();
  });
});

describe("取り込みと形式の検査", () => {
  it("更新日ごとの 1 枚を全部持つ。sources に、ファイル名・sha256・件数が残る", () => {
    const raw = path.join(tmp, "a");
    put(raw, "shinryo", "20261001", "s_20261001.csv", sjis(SHINRYO.slice(0, 2)));
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(SHINRYO));
    put(raw, "tensuhyo", "20261102", "03-1 x.csv", sjis(HAIHAN));
    // 更新日の形でないフォルダと、config にない名前のファイルは読まない
    put(raw, "shinryo", "old", "s_20260101.csv", sjis(SHINRYO));
    put(raw, "shinryo", "20261102", "memo.txt", Buffer.from("x"));
    const { db, rejected } = build(raw);
    expect(rejected).toEqual([]);
    expect(count(db, "shinryo", "20261001")).toBe(2);
    expect(count(db, "shinryo", "20261102")).toBe(3);
    const src = db.prepare("SELECT dataset, snapshot, generation, tbl, file, rows, length(sha256) AS sha FROM sources ORDER BY tbl, snapshot").all();
    expect(src).toEqual([
      { dataset: "tensuhyo", snapshot: "20261102", generation: "R8", tbl: "haihan", file: "03-1 x.csv", rows: 1, sha: 64 },
      { dataset: "shinryo", snapshot: "20261001", generation: "R8", tbl: "shinryo", file: "s_20261001.csv", rows: 2, sha: 64 },
      { dataset: "shinryo", snapshot: "20261102", generation: "R8", tbl: "shinryo", file: "s_20261102.csv", rows: 3, sha: 64 },
    ]);
    expect(db.prepare("SELECT tani, code1, code2, kubun, tokurei FROM haihan").all()).toEqual([{ tani: 1, code1: OUSHIN, code2: HOUMON, kubun: "3", tokurei: "1" }]);
    const row = shinryoOf(db, "20261102", KINKYU)!;
    expect([row.name, row.points, row.chu_code, row.chu_seq, row.kokuji1]).toEqual(["緊急往診加算（在支診等）", pt("C000_N1_KINKYU"), 1401, "1", "7"]);
    expect(shinryoOf(db, "20261001", HOUMON)).toBeNull();
  });

  it("診療年月から使う 1 枚：末日以前でいちばん新しい 1 枚。なければ後の 1 枚（印つき）。世代の組がなければ、ない", () => {
    const { db } = build(path.join(tmp, "a"));
    expect(pickSnapshot(db, "shinryo", "2026-10", "R8")).toEqual({ snapshot: "20261001", later: false });
    expect(pickSnapshot(db, "shinryo", "2026-12", "R8")).toEqual({ snapshot: "20261102", later: false });
    expect(pickSnapshot(db, "shinryo", "2026-09", "R8")).toEqual({ snapshot: "20261001", later: true });
    expect(pickSnapshot(db, "shinryo", "2026-10", "R6")).toBeNull();
    expect(pickSnapshot(db, "iyakuhin", "2026-10", "R8")).toBeNull();
    expect(pickSnapshot(db, "shinryo", "2026-13", "R8")).toBeNull();
  });

  it("形式が合わないファイルは、その 1 枚を取り込まずに理由を残す（ほかのファイルは取り込む）", () => {
    const cases: [string, Uint8Array, RegExp][] = [
      ["項目数", sjis([SHINRYO[0].slice(0, 149)]), /1 行目：項目数が合わない/],
      ["値の区分", sjis([SHINRYO[0], shinryoRow(HOUMON, "x", 890, { 13: "7" })]), /2 行目：項番 13（入外適用区分）の値が仕様の形と違う/],
      ["1 列ずれ", sjis([["0", ...SHINRYO[0].slice(0, 149)]]), /1 行目：項番 3（診療行為コード）/],
      ["文字コード", Buffer.concat([Buffer.from([0x22, 0x81, 0x22, 0x0d, 0x0a])]), /Shift_JIS として読めない/],
      ["件数 0", Buffer.from("\r\n"), /件数が 0/],
      ["同じコード", sjis([SHINRYO[0], SHINRYO[0]]), /2 行目：同じコードの行が 2 つある/],
      ["引用符", Buffer.from('"0","S\r\n'), /引用符が閉じていない/],
    ];
    for (const [name, bytes, reason] of cases) {
      const raw = path.join(tmp, `bad-${name}`);
      put(raw, "shinryo", "20261102", "s_20261102.csv", bytes);
      put(raw, "tensuhyo", "20261102", "03-1_x.csv", sjis(HAIHAN));
      const { db, rejected } = build(raw);
      expect(rejected.map((r) => r.reason), name).toEqual([expect.stringMatching(reason)]);
      expect(count(db, "shinryo", "20261102"), name).toBe(0);
      expect(db.prepare("SELECT tbl FROM sources").all(), name).toEqual([{ tbl: "haihan" }]);
      expect(db.prepare("SELECT count(*) AS n FROM rejected").get(), name).toEqual({ n: 1 });
    }
  });

  it("見出しの行が仕様と違うファイル・同じ形の名前が 2 つあるフォルダ・世代より前の更新分は取り込まない", () => {
    const raw = path.join(tmp, "b");
    put(raw, "checkmaster", "20261030", "IY_HeiyoKinki_x.csv", sjis([["医薬品コード", "相手", "予備1", "予備2", "予備3", "予備4", "予備5", "予備6", "変更区分", "参照範囲"]]));
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(SHINRYO));
    put(raw, "shinryo", "20261102", "S_20261101.CSV", sjis(SHINRYO));
    put(raw, "checkmaster", "20251031", "IY_HeiyoKinki_x.csv", Buffer.from("x"));
    const { rejected } = build(raw);
    expect(rejected.map((r) => `${r.dataset}/${r.snapshot}：${r.reason}`).sort()).toEqual([
      "checkmaster/20251031：世代 R8 より前の更新分（20260601 より前）",
      "checkmaster/20261030：1 行目：見出しの行が仕様と違う",
      "shinryo/20261102：同じ形の名前のファイルが 2 つ以上ある",
    ]);
  });

  it("大きさ・行数・1 行の長さの上限を超えるファイルは断る（流して読む）", () => {
    const file = path.join(tmp, "limit.csv");
    writeFileSync(file, sjis([["1", "2"], ["3", "4"], ["5", "6"]]));
    const rows: string[][] = [];
    expect(readCsv(file, (c) => rows.push(c)).bytes).toBe(27);
    expect(rows).toEqual([["1", "2"], ["3", "4"], ["5", "6"]]);
    const limits = { maxBytes: 1000, maxRows: 1000, maxLineChars: 1000 };
    expect(() => readCsv(file, () => {}, { ...limits, maxBytes: 26 })).toThrow(/ファイルが大きすぎる/);
    expect(() => readCsv(file, () => {}, { ...limits, maxRows: 2 })).toThrow(/行数が上限を超えている/);
    expect(() => readCsv(file, () => {}, { ...limits, maxLineChars: 5 })).toThrow(MasterFormatError);
  });
});

describe("錨・件数・版の表との食い違い・点検の準備", () => {
  const A46 = `| A46 | \`haihan\` | \`tani=1, code1=${OUSHIN}, code2=${HOUMON}\` | \`kubun=3, tokurei=1\` | 往診料と訪問診療料 | 留意 p244 |`;
  const A04 = `| A04 | \`shinryo\` | \`code=${KINKYU}\` | \`points=650, kokuji1=7, chu_code=1401, chu_seq=1\` | 緊急往診加算 | 告示 p135 |`;
  const one = (anchors: string[], counts: string[] = [], revisions: Revision[] = [], verified?: string) => {
    const { db } = build(path.join(tmp, "a"));
    return { db, result: verifyMasters(db, parseEm(EM(anchors, counts, verified)), { write: true, revisions }) };
  };

  it("EM §2-11 の表を読む。節の外の行は読まない。表にない列・番号の重複は、書き誤りとして断る", () => {
    const em = parseEm(EM([A46, A04], ["| `shinryo` | — | 3 |", "| `haihan` | `tani=1, tokurei=1` | 8,720 |"]));
    expect(em.verified).toEqual({ shinryo: "20261102", tensuhyo: "20261102" });
    expect(em.anchors).toEqual([
      { id: "A46", table: "haihan", where: { tani: "1", code1: OUSHIN, code2: HOUMON }, expect: { kubun: "3", tokurei: "1" } },
      { id: "A04", table: "shinryo", where: { code: KINKYU }, expect: { points: "650", kokuji1: "7", chu_code: "1401", chu_seq: "1" } },
    ]);
    expect(em.counts).toEqual([{ table: "shinryo", where: {}, count: 3 }, { table: "haihan", where: { tani: "1", tokurei: "1" }, count: 8720 }]);
    expect(em.names.get(OUSHIN)).toBe("往診料");
    expect(() => parseEm(EM([A46.replace("kubun=3", "kubn=3")], []))).toThrow(/表 haihan にない列: kubn/);
    expect(() => parseEm(EM([A46, A46], []))).toThrow(/番号が重複/);
    expect(() => parseEm(EM([A46.replace("`haihan`", "`sources`")], []))).toThrow(/知らない表/);
    expect(() => parseEm("### 2-8. 採用した診療行為コード\n")).toThrow(/2-11/);
  });

  it("錨が全部成り立てば失敗 0。持っている 1 枚ごとに確かめ、1 つでも外れたら失敗（当たる行がないのも外れ）", () => {
    expect(one([A46]).result.failures).toBe(0);
    // 緊急往診加算は 20261001 と 20261102 の 2 枚にある
    const ok = one([A46, A04]).result;
    expect(ok.failures).toBe(0);
    expect(ok.lines[0]).toBe("錨：2 個のうち 2 個が通った（データがなくて確かめていない 0 個）。確かめた回数 3");
    const bad = one([A46.replace("tokurei=1", "tokurei=0"), A04.replace(KINKYU, HOUMON)]).result;
    // A04 は 2 枚とも外れる（20261001 には行がなく、20261102 の行は点数が違う）
    expect(bad.failures).toBe(3);
    expect(bad.lines.slice(0, 2)).toEqual([
      `錨 A46 が外れた（haihan 20261102）：tani=1, code1=${OUSHIN}, code2=${HOUMON} の行は 1 件、そのうち kubun=3, tokurei=0 は 0 件`,
      `錨 A04 が外れた（shinryo 20261001）：code=${HOUMON} の行は 0 件、そのうち points=650, kokuji1=7, chu_code=1401, chu_seq=1 は 0 件`,
    ]);
    // データのない表の錨は、外れではなく「確かめていない」
    const none = one([`| A60 | \`kaisu\` | \`code=${HOUMON}, unit_code=121\` | \`limit_count=1\` | 1 日 1 回 | 告示 p136 |`]).result;
    expect(none.failures).toBe(0);
    expect(none.lines[0]).toMatch(/データがなくて確かめていない 1 個/);
  });

  it("件数：確かめた版と同じ 1 枚では一致しなければ失敗。ほかの 1 枚では、1 割を超えて違えば警告", () => {
    const counts = ["| `shinryo` | — | 3 |", "| `shinryo` | `kokuji1=7` | 1 |"];
    // 20261102（確かめた版）は 3 行で一致。20261001 は 2 行で、3 行と 1 割を超えて違う
    const ok = one([], counts).result;
    expect([ok.failures, ok.warnings]).toEqual([0, 1]);
    expect(ok.lines).toContain("警告：件数が 1 割を超えて違う（shinryo 20261001）： は 2 件、確かめた版（20261102）は 3 件");
    const bad = one([], ["| `shinryo` | `kokuji1=7` | 2 |"]).result;
    expect(bad.failures).toBe(1);
    expect(bad.lines).toContain("件数が違う（shinryo 20261102）：kokuji1=7 は 1 件、EM §2-11 は 2 件");
  });

  it("読み方を確かめた版より新しいデータは、止めずに警告にし、sources に確かめた版を残す", () => {
    const { db, result } = one([], [], [], "20261001");
    expect(result.failures).toBe(0);
    expect(result.lines).toContain("警告：読み方を確かめた版（20261001）より新しいデータです：shinryo 20261102");
    expect(db.prepare("SELECT DISTINCT verified FROM sources").all()).toEqual([{ verified: "20261001" }]);
  });

  it("版の表とマスターが食い違えば、全部出して失敗にする（診療年月に当たる 1 枚ごと）", () => {
    const rev = { ...r2026, codes: { C000: r2026.codes.C000, C000_N1_KINKYU: r2026.codes.C000_N1_KINKYU }, bundles: [] } as Revision;
    expect(one([], [], [rev]).result.lines).toContain("版の表との食い違い：0 件");
    const off = { ...rev, points: { ...rev.points, C000: { ...rev.points.C000, points: 721 } } } as Revision;
    const bad = one([], [], [off]).result;
    // r2026 の最初の月（2026-06）は後の 1 枚（20261001）で代え、期間の中の更新日（20261102）の 1 枚も見る
    expect(bad.failures).toBe(2);
    expect(bad.lines).toContain(`版の表と食い違う（shinryo 20261102）：r2026 C000 ${OUSHIN}：点数が違う（マスター 720／点数表 721）`);
    expect(bad.lines).toContain("版の表との食い違い：2 件");
    // 訪問診療料は 20261001 の 1 枚にない
    const missing = one([], [], [{ ...rev, codes: { C001_1I: r2026.codes.C001_1I } } as Revision]).result;
    expect(missing.lines).toContain(`版の表と食い違う（shinryo 20261001）：r2026 C001_1I ${HOUMON}：マスターにない`);
  });

  it("点検の準備：要る表がなければ「データがない」、判定に使う列の値に錨がなければ「錨がない」。そろった点検だけが準備できている", () => {
    const { db, result } = one([A46]);
    const g05 = result.ready.find((r) => r.check === "G05")!;
    expect(g05.ready).toBe(false);
    // tani=1 の特例条件あり・背反区分 3 には錨がある。ほかの値にはない
    expect(g05.missing).not.toContain("haihan:tani=1, tokurei=1");
    expect(g05.missing).toContain("haihan:tani=1, tokurei=0");
    expect(g05.missing).toContain("haihan:tani=4, kubun=3");
    expect(result.ready.find((r) => r.check === "G09")).toMatchObject({ ready: false, reason: "データがない：checkmaster", missing: ["データ:checkmaster"] });
    expect(result.ready.every((r) => !r.ready)).toBe(true);
    expect(db.prepare("SELECT count(*) AS n, sum(ready) AS ready FROM checks_ready").get()).toEqual({ n: 9, ready: 0 });
    // 外れた錨は、準備に数えない
    const off = one([A46.replace("kubun=3", "kubun=1")]).result.ready.find((r) => r.check === "G05")!;
    expect(off.missing).toContain("haihan:tani=1, tokurei=1");
  });
});

describe("アプリからの読み取り", () => {
  it("masters.db がなければ「ない」を返す（例外にしない）。あれば、入っているデータと点検の準備を返す", () => {
    const dir = path.join(tmp, "app");
    mkdirSync(dir, { recursive: true });
    const before = process.env.RESEMEN_MASTER_DIR;
    process.env.RESEMEN_MASTER_DIR = dir;
    try {
      expect(openMasters()).toBeNull();
      expect(mastersStatus()).toEqual({ present: false, sources: [], checks: [], rejected: [] });
      // 中身が SQLite でないファイルも「ない」
      writeFileSync(path.join(dir, "masters.db"), "x");
      expect(mastersStatus().present).toBe(false);
      rmSync(path.join(dir, "masters.db"));
      const db = new Database(path.join(dir, "masters.db"));
      createSchema(db);
      ingestAll(db, path.join(tmp, "a"), MASTERS_CONFIG, "2026-11-21T00:00:00.000Z");
      verifyMasters(db, parseEm(EM([], [], "20261001")), { write: true, revisions: [] });
      db.close();
      const status = mastersStatus();
      expect(status.present).toBe(true);
      expect(status.sources.map((s) => [s.table, s.snapshot, s.rows, s.newer])).toEqual([["shinryo", "20261001", 2, false], ["shinryo", "20261102", 3, true], ["haihan", "20261102", 1, true]]);
      expect(status.checks).toHaveLength(9);
      // 読み取り専用で開く
      const ro = openMasters()!;
      expect(() => ro.exec("DELETE FROM sources")).toThrow();
      ro.close();
    } finally {
      if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
      else process.env.RESEMEN_MASTER_DIR = before;
    }
  });
});
