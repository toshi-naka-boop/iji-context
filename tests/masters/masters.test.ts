// 公開データの取り込み（src/masters/。design.md §12-1）。データは同梱しないので、EM に採用済みのコード・点数だけで手で作った数行の表で確かめる（公開元の表の行は写していない）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import iconv from "iconv-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Revision } from "../../src/engine/revisions/types";
import { carryOver, createSchema, ingestAll } from "../../src/masters/build";
import { MASTERS_CONFIG, snapshotOf } from "../../src/masters/config";
import { MasterFormatError, readCsv } from "../../src/masters/csv";
import { checkReady, hasUnitColumns, mastersStatus, OLD_SHISETSU_G03_REASON, OLD_SHISETSU_REASON, openMasters, pickSnapshot, shinryoOf, unitCaseCollisions } from "../../src/masters/db";
import { LAYOUTS } from "../../src/masters/layout";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAbout, GenericClaim, GenericResult } from "../../src/generic/types";
import { parseEm, readEm, verifyMasters, type Em } from "../../src/masters/verify";

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

  it("判定に使わない列（layout の loose）は形を見ない：値が仕様の形と違っても、表ごと落とさずに文字のまま持つ（round-32 O-20）", () => {
    const raw = path.join(tmp, "loose");
    // 項番 14（後期高齢者医療適用区分）・項番 43（時間加算区分）は判定に使わない。仕様にない値を入れる
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis([SHINRYO[0], shinryoRow(HOUMON, "x", 890, { 14: "9", 43: "AB" })]));
    const { db, rejected } = build(raw);
    expect(rejected).toEqual([]);
    expect(count(db, "shinryo", "20261102")).toBe(2);
    expect(db.prepare("SELECT kouki, time_kasan FROM shinryo WHERE code = ?").get(HOUMON)).toEqual({ kouki: "9", time_kasan: "AB" });
    // 判定に使う列は、今までどおり形を見る（上の「値の区分」の例）
    for (const l of LAYOUTS) for (const col of l.loose ?? []) expect(l.columns.some((x) => x.col === col), `${l.id}.${col}`).toBe(true);
    const shinryo = LAYOUTS.find((l) => l.id === "shinryo")!;
    expect(shinryo.loose).not.toContain("nyugai");
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

describe("世代ごとの 1 枚を残す（design.md §14-4。X-125）", () => {
  it("世代を替えて作り直すと、前の世代のデータごとのいちばん新しい 1 枚だけを今の masters.db から写す。いまの世代は raw から作り、確かめるのはいまの世代の 1 枚だけ", () => {
    const raw = path.join(tmp, "carry");
    put(raw, "shinryo", "20261001", "s_20261001.csv", sjis(SHINRYO.slice(0, 2)));
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(SHINRYO));
    put(raw, "tensuhyo", "20261102", "03-1 x.csv", sjis(HAIHAN));
    const oldFile = path.join(tmp, "carry-old.db");
    const old = new Database(oldFile);
    createSchema(old);
    ingestAll(old, raw, MASTERS_CONFIG, "2026-11-21T00:00:00.000Z");
    old.close();
    // 次の世代（仮に R10）の raw：20280601 の 1 枚だけ（前の世代の更新分は since より前なので取り込まない）
    const next = { ...MASTERS_CONFIG, generation: "R10", datasets: Object.fromEntries(Object.entries(MASTERS_CONFIG.datasets).map(([k, d]) => [k, { ...d, since: "20280601" }])) };
    const raw2 = path.join(tmp, "carry-next");
    put(raw2, "shinryo", "20280601", "s_20280601.csv", sjis(SHINRYO.slice(0, 1)));
    put(raw2, "shinryo", "20261102", "s_20261102.csv", sjis(SHINRYO));
    const db = new Database(":memory:");
    createSchema(db);
    const rejected = ingestAll(db, raw2, next, "2028-06-10T00:00:00.000Z");
    expect(rejected.map((r) => [r.dataset, r.snapshot])).toEqual([["shinryo", "20261102"]]);
    expect(carryOver(db, oldFile, "R10")).toBe(2);
    const src = db.prepare("SELECT dataset, snapshot, generation, tbl FROM sources ORDER BY generation, dataset, snapshot").all();
    expect(src).toEqual([
      { dataset: "shinryo", snapshot: "20280601", generation: "R10", tbl: "shinryo" },
      { dataset: "shinryo", snapshot: "20261102", generation: "R8", tbl: "shinryo" },
      { dataset: "tensuhyo", snapshot: "20261102", generation: "R8", tbl: "haihan" },
    ]);
    expect([count(db, "shinryo", "20261102"), count(db, "haihan", "20261102"), count(db, "shinryo", "20261001")]).toEqual([3, 1, 0]);
    expect(pickSnapshot(db, "shinryo", "2026-10", "R8")).toEqual({ snapshot: "20261102", later: true });
    // 確かめるのはいまの世代の 1 枚だけ（前の世代の 1 枚の錨は、その世代のときに確かめてある）
    const em = parseEm(EM([`| A99 | \`shinryo\` | \`code=${HOUMON}\` | \`points=${pt("C001_1I")}\` | 訪問診療料 | 錨 |`], []));
    const v = verifyMasters(db, em, { write: false, config: next, revisions: [] });
    expect(v.lines.filter((l) => l.startsWith("錨"))).toEqual([`錨 A99 が外れた（shinryo 20280601）：code=${HOUMON} の行は 0 件、そのうち points=${pt("C001_1I")} は 0 件`, "錨：1 個のうち 0 個が通った（データがなくて確かめていない 0 個）。確かめた回数 1"]);
    // 同じ世代で作り直すときは写さない。今の masters.db がなければ何もしない
    expect(carryOver(db, oldFile, "R8")).toBe(0);
    expect(carryOver(db, path.join(tmp, "none.db"), "R10")).toBe(0);
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
    expect(db.prepare("SELECT count(*) AS n, sum(ready) AS ready FROM checks_ready").get()).toEqual({ n: 11, ready: 0 });
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
      expect(status.checks).toHaveLength(11);
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

describe("施設基準の組ごとの列（design.md §15-3。J-3）", () => {
  const root = path.join(__dirname, "..", "..");
  const ids = ["A109", "A110", "A111", "A112", "A113", "A114", "A115", "A116"];
  /** EM §2-11 表 2 の施設基準の錨だけ（コード・点数・施設基準の値は EM の採用値） */
  const real = readEm(root);
  const em: Em = { ...real, anchors: real.anchors.filter((a) => ids.includes(a.id)), formulas: [], counts: [] };
  const START = { shisetsu_g1: 72, shisetsu_g2: 78, shisetsu_g3: 81 } as const;
  /** 錨の確かめる値から、医科診療行為マスターの 1 行を作る。shift は施設基準の項番をずらす数（組の列をずらした作り物） */
  const rowsOf = (shift: number) =>
    em.anchors.map((a) => {
      const set: Record<number, string> = {};
      for (const [col, start] of Object.entries(START)) {
        const v = a.expect[col] ?? "0";
        if (v !== "0") v.split("/").forEach((code, i) => (set[start + i + shift] = code));
      }
      return shinryoRow(a.where.code, `手作りの行 ${a.where.code}`, Number(a.expect.points ?? 0), set);
    });
  const run = (name: string, shift: number) => {
    const raw = path.join(tmp, `shisetsu-${name}`);
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(rowsOf(shift)));
    const { db, rejected } = build(raw);
    expect(rejected).toEqual([]);
    return { db, result: verifyMasters(db, em, { write: true, revisions: [] }) };
  };
  const failed = (lines: string[]) => [...new Set(lines.map((l) => /^錨 (A\d+) が外れた/.exec(l)?.[1]).filter(Boolean))];

  it("EM §2-11 に錨 A109〜A116 と、組ごとの件数（≠0）の 3 行がある", () => {
    expect(em.anchors.map((a) => a.id)).toEqual(ids);
    expect(real.counts.filter((c) => c.not)).toEqual([
      { table: "shinryo", where: {}, not: { shisetsu_g1: "0" }, count: 4623 },
      { table: "shinryo", where: {}, not: { shisetsu_g2: "0" }, count: 900 },
      { table: "shinryo", where: {}, not: { shisetsu_g3: "0" }, count: 286 },
    ]);
  });

  it("組ごとに 0 でないコードを項番の順に「/」でつなぎ、全部 0 なら 0。錨が全部通り、G03・G10・G11 の準備ができる", () => {
    const { db, result } = run("ok", 0);
    expect(db.prepare("SELECT shisetsu_g1, shisetsu_g2, shisetsu_g3 FROM shinryo WHERE code = '114717810'").get()).toEqual({ shisetsu_g1: "3055/4247/3057/3058", shisetsu_g2: "721", shisetsu_g3: "4101" });
    expect(db.prepare("SELECT shisetsu_g1, shisetsu_g2, shisetsu_g3 FROM shinryo WHERE code = '114018470'").get()).toEqual({ shisetsu_g1: "0", shisetsu_g2: "0", shisetsu_g3: "0" });
    expect([result.failures, failed(result.lines)]).toEqual([0, []]);
    expect(result.ready.find((r) => r.check === "G11")).toMatchObject({ ready: true });
    // G10 は区分番号の列の錨（A70・A72・A73）も要る（下の「区分番号の列」）。施設基準の列の錨は足りている
    expect(result.ready.find((r) => r.check === "G10")!.missing).toEqual(["shinryo:sho", "shinryo:bu", "shinryo:kubun_no", "shinryo:eda", "shinryo:kou"]);
    expect(result.ready.find((r) => r.check === "G03")!.missing.filter((m) => m.includes("shisetsu"))).toEqual([]);
  });

  it("組の列を 1 つずらした作り物の CSV では、錨が外れて失敗する（masters:build は失敗で masters.db を置き換えない）", () => {
    // 後ろへ 1 つ：組③の 4101 が項番82（施設基準の外）に出て、A112 が外れる
    const later = run("later", 1).result;
    expect(later.failures).toBeGreaterThan(0);
    expect(failed(later.lines)).toEqual(["A112"]);
    // 前へ 1 つ：組①の先頭が項番71（施設基準の外）に、組②の先頭が組①に入る。施設基準のない A116 だけが通る
    const earlier = run("earlier", -1).result;
    expect(earlier.failures).toBeGreaterThan(0);
    expect(failed(earlier.lines)).toEqual(ids.slice(0, 7));
  });

  it("件数の「列≠値」：その値でない行を数え、合わなければ失敗。錨では「≠」を断る", () => {
    const { db } = run("count", 0);
    const em2 = parseEm(EM([], ["| `shinryo` | `shisetsu_g3≠0` | 1 |", "| `shinryo` | `shisetsu_g2≠0, shisetsu_g1=721` | 2 |"]));
    const r = verifyMasters(db, em2, { write: false, revisions: [] });
    // 組②に値がある行は A109・A110・A112 の 3 行。そのうち組①が 721 の行はない
    expect(r.lines.filter((l) => l.startsWith("件数が違う"))).toEqual(["件数が違う（shinryo 20261102）：shisetsu_g1=721, shisetsu_g2≠0 は 0 件、EM §2-11 は 2 件"]);
    expect(r.failures).toBe(1);
    expect(() => parseEm(EM(["| A99 | `shinryo` | `code=1` | `shisetsu_g1≠0` | x | y |"], []))).toThrow(/「≠」は件数の表だけで使える/);
  });

  it("組ごとの列のない古い形の masters.db では、G10・G11 が準備できていない（作り直しを促す）。ほかの点検は checks_ready のまま", () => {
    const { db } = run("old", 0);
    db.exec("ALTER TABLE shinryo DROP COLUMN shisetsu_g1; ALTER TABLE shinryo DROP COLUMN shisetsu_g2; ALTER TABLE shinryo DROP COLUMN shisetsu_g3; ALTER TABLE shinryo ADD COLUMN shisetsu TEXT NOT NULL DEFAULT ''");
    db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, '')").run();
    for (const id of ["G10", "G11"]) expect(checkReady(db, id)).toEqual({ ready: false, reason: OLD_SHISETSU_REASON });
    expect(checkReady(db, "G03")).toEqual({ ready: true, reason: "" });
    // 古い形では「届出が要ります」の印を付けず、理由を G03 の点検の範囲の文と設定の画面の G03 の行に出す（黙って消さない。code M-8）
    const scope = genericScopeOf({ units: [] } as unknown as GenericClaim, db, { yearMonth: "2026-10", generation: "R8" } as GenericAbout, { ran: [{ check: "G03", kind: "行の属性" }], findings: [] } as unknown as GenericResult);
    expect(scope.notDone).toContain(OLD_SHISETSU_G03_REASON);
    // 設定の画面（mastersStatus）にも、行がなくても G10・G11 を出す
    const dir = path.join(tmp, "old-app");
    mkdirSync(dir, { recursive: true });
    db.prepare("DELETE FROM checks_ready WHERE check_id IN ('G10', 'G11')").run();
    db.exec(`VACUUM INTO '${path.join(dir, "masters.db")}'`);
    const before = process.env.RESEMEN_MASTER_DIR;
    process.env.RESEMEN_MASTER_DIR = dir;
    try {
      expect(mastersStatus().checks.filter((c) => ["G03", "G10", "G11"].includes(c.check))).toEqual([
        { check: "G03", ready: true, reason: OLD_SHISETSU_G03_REASON },
        { check: "G10", ready: false, reason: OLD_SHISETSU_REASON },
        { check: "G11", ready: false, reason: OLD_SHISETSU_REASON },
      ]);
    } finally {
      if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
      else process.env.RESEMEN_MASTER_DIR = before;
    }
  });
});

describe("区分番号の列（design.md §15-3。code M-1）", () => {
  const root = path.join(__dirname, "..", "..");
  const real = readEm(root);
  const ids = ["A70", "A72", "A73"];
  const em: Em = { ...real, anchors: real.anchors.filter((a) => ids.includes(a.id)), formulas: [], counts: [] };
  /** 錨の確かめる値の列 → 医科診療行為マスターの項番 */
  const ITEM: Record<string, number> = { time_kasan: 43, kensa_kind: 50, kensa_group: 51, alpha: 85, sho: 90, bu: 91, kubun_no: 92, eda: 93, kou: 94, kokuji1: 68 };
  const rowsOf = (kou?: string) =>
    em.anchors.map((a) => {
      const set: Record<number, string> = {};
      for (const [col, v] of Object.entries(a.expect)) if (ITEM[col]) set[ITEM[col]] = v;
      if (kou !== undefined) set[94] = kou;
      return shinryoRow(a.where.code, `手作りの行 ${a.where.code}`, 0, set);
    });
  it("EM の A70・A72・A73 が区分番号の 5 列を縛り、G05・G10 の準備に入る", () => {
    expect(em.anchors.map((a) => a.id)).toEqual(ids);
    const raw = path.join(tmp, "kubun-ok");
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(rowsOf()));
    const { db, rejected } = build(raw);
    expect(rejected).toEqual([]);
    const r = verifyMasters(db, em, { write: false, revisions: [] });
    expect(r.failures).toBe(0);
    for (const id of ["G05", "G10"]) expect([id, r.ready.find((x) => x.check === id)!.missing.filter((m) => /:(sho|bu|kubun_no|eda|kou)$/.test(m))]).toEqual([id, []]);
  });
  it("項番（kou）は形を見る列になった：数字でない値の行があれば、その表を作らない", () => {
    const raw = path.join(tmp, "kubun-bad");
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(rowsOf("X")));
    expect(build(raw).rejected.map((r) => r.reason)).toEqual([expect.stringContaining("項番 94")]);
  });
  it("錨（A70・A72・A73）の項番が外れた masters.db では、G10 の準備ができていない（段 17e）", () => {
    const raw = path.join(tmp, "kubun-off");
    // 形は数字のまま、値だけを錨と違えた行（列を読み違えたときと同じ）
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis(rowsOf("7")));
    const { db, rejected } = build(raw);
    expect(rejected).toEqual([]);
    const r = verifyMasters(db, em, { write: false, revisions: [] });
    expect(r.failures).toBeGreaterThan(0);
    expect(r.ready.find((x) => x.check === "G10")!.ready).toBe(false);
  });
});

describe("単位の列（design.md §15-3。round-52 C-262。錨の案 A117〜A119 は EM の追記 E-8 の承認待ち）", () => {
  // E-8 の錨の案（design.md §15-3）。EM に写すまでは、ここで作り物の EM の表として照らす
  const ANCHORS = [
    "| A117 | `shinryo` | `code=114001470` | `unit_code=1, unit_name=分` | 患家診療時間加算の数量の単位は分 | 原本の CSV |",
    "| A118 | `iyakuhin` | `code=620008991` | `unit_code=33, unit_name=ｇ` | ゲーベンクリーム１％の単位は ｇ | 原本の CSV |",
    "| A119 | `tokutei` | `code=739210000` | `unit_code=37, unit_name=Ｌ` | 液体酸素・可搬式液化酸素容器の単位は Ｌ | 原本の CSV |",
  ];
  const em = parseEm(EM(ANCHORS, []));
  const iyakuhinRow = (code: string, unitCode: string, unitName: string, set: Record<number, string> = {}) => {
    const c = Array.from({ length: 42 }, () => "0");
    for (const [n, v] of Object.entries({ 3: code, 5: `手作りの薬 ${code}`, 8: unitCode, 10: unitName, 11: "1", 12: "10.00", 28: "6", 30: "20260601", 31: "99999999", ...set })) c[Number(n) - 1] = v;
    return c;
  };
  const tokuteiRow = (code: string, unitCode: string, unitName: string) => {
    const c = Array.from({ length: 38 }, () => "0");
    for (const [n, v] of Object.entries({ 3: code, 5: `手作りの器材 ${code}`, 8: unitCode, 10: unitName, 11: "1", 12: "0.32", 21: "3", 28: "20260601", 29: "00000000", 30: "99999999" })) c[Number(n) - 1] = v;
    return c;
  };
  /** at は単位の名前を置く項番（10 が仕様。ずらした作り物は 9 か 11） */
  const run = (name: string, at = 10, units: { shinryo?: string; iyakuhin?: string } = {}) => {
    const raw = path.join(tmp, `units-${name}`);
    const unitSet = (code: string, unitName: string): Record<number, string> => (at === 10 ? { 8: code, 10: unitName } : { 8: code, [at]: unitName, 10: "" });
    put(raw, "shinryo", "20261102", "s_20261102.csv", sjis([shinryoRow("114001470", "患家診療時間加算", 100, unitSet("1", units.shinryo ?? "分"))]));
    put(raw, "iyakuhin", "20261112", "y_20261112.csv", sjis([iyakuhinRow("620008991", "33", units.iyakuhin ?? "ｇ")]));
    put(raw, "tokutei", "20261001", "t_20261001.csv", sjis([tokuteiRow("739210000", "37", "Ｌ")]));
    const { db, rejected } = build(raw);
    return { db, rejected, result: verifyMasters(db, em, { write: false, revisions: [] }) };
  };
  it("医科診療行為の unit_code・unit_name、医薬品・特定器材の unit_name を読み、錨の案 A117〜A119 が通る", () => {
    const { db, rejected, result } = run("ok");
    expect(rejected).toEqual([]);
    expect(db.prepare("SELECT unit_code, unit_name FROM shinryo WHERE code = '114001470'").get()).toEqual({ unit_code: 1, unit_name: "分" });
    expect(db.prepare("SELECT unit_code, unit_name FROM iyakuhin WHERE code = '620008991'").get()).toEqual({ unit_code: 33, unit_name: "ｇ" });
    expect(db.prepare("SELECT unit_code, unit_name FROM tokutei WHERE code = '739210000'").get()).toEqual({ unit_code: 37, unit_name: "Ｌ" });
    expect([result.failures, result.lines.filter((l) => l.startsWith("錨："))]).toEqual([0, ["錨：3 個のうち 3 個が通った（データがなくて確かめていない 0 個）。確かめた回数 3"]]);
  });
  it("単位の列を 1 つずらした作り物の CSV では、錨が外れるか表を作らない", () => {
    const before = run("before", 9);
    expect(before.result.failures).toBeGreaterThan(0);
    expect(before.result.lines.some((l) => l.startsWith("錨 A117 が外れた"))).toBe(true);
    // 後ろへ 1 つ：項番11（点数識別）に単位の名前が入り、医科診療行為マスターを作らない
    const after = run("after", 11);
    expect(after.rejected.map((r) => r.reason)).toEqual([expect.stringContaining("項番 11")]);
  });
  it("大文字・小文字の衝突：3 表の単位の名前を小文字にそろえて同じになる、元の字の違う名前の組を求める", () => {
    expect(unitCaseCollisions(run("same").db)).toEqual([]);
    expect(unitCaseCollisions(run("collide", 10, { shinryo: "mL", iyakuhin: "ml" }).db)).toEqual([["mL", "ml"]]);
    expect(unitCaseCollisions(run("collide-wide", 10, { shinryo: "ｍＬ", iyakuhin: "ｍｌ" }).db)).toEqual([["ｍＬ", "ｍｌ"]]);
  });
  it("単位の列のない古い masters.db：G11 の準備は止めず（checks_ready のまま）、単位の列が古い形であることだけが分かる", () => {
    const { db } = run("old");
    expect(hasUnitColumns(db)).toBe(true);
    db.exec("ALTER TABLE iyakuhin DROP COLUMN unit_name");
    db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G11', 1, '')").run();
    expect(hasUnitColumns(db)).toBe(false);
    expect(checkReady(db, "G11")).toEqual({ ready: true, reason: "" });
  });
});
