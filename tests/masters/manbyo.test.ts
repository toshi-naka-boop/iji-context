// 万病辞書 MANBYO の取り込みと、略語の意味の候補（spec FR-211。plan-fr211.md「辞書方式の決め」1・7）。
// 辞書の本体は使わない。列の形だけをまねた小さな作り物の CSV で、取り込みの検査（見出し・項目数・信頼度・文字コード）と、意味の読み方を確かめる
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { candidatesOf, MANBYO_CREDIT, manbyoOf, meaningsOf } from "../../src/chart/abbrev-dict";
import { createSchema, ingestAll } from "../../src/masters/build";
import { MASTERS_CONFIG } from "../../src/masters/config";
import { mastersStatus } from "../../src/masters/db";

const tmp = mkdtempSync(path.join(tmpdir(), "iji-manbyo-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HEADER = "出現形,出現形よみ,ICDコード,標準病名,信頼度レベル,頻度レベル";
/** 作り物の行（列の形だけをまねる。意味は試すための値） */
const ROWS = ["ＡＦ,えーえふ,I489,心房細動,C,5-10%", "Ａｆ,えーえふ,I490,心室細動,C,90-95%", "ＡＭＩ,えーえむあい,I219,心臓破裂;心筋梗塞,A,10-15%", "ＡＤＬ,,,,F,0-5%", "ＸＹ,,-1,-1,F,0-5%", "発熱,はつねつ,R509,発熱,S,95-100%"];
function build(name: string, lines: string[], bytes?: Buffer) {
  const raw = path.join(tmp, name);
  const dir = path.join(raw, "manbyo", "20210602");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "MANBYO_20210602.csv"), bytes ?? Buffer.from(`${lines.join("\n")}\n`, "utf8"));
  const db = new Database(":memory:");
  createSchema(db);
  const rejected = ingestAll(db, raw, MASTERS_CONFIG, "2026-11-25T00:00:00.000Z");
  return { db, rejected };
}

describe("万病辞書の取り込み（手で置く。公開マスターと同じ置き場・同じ検査）", () => {
  it("config：手で置くデータで（落とさない）、UTF-8、出典（CC BY 4.0）を持つ", () => {
    const ds = MASTERS_CONFIG.datasets.manbyo;
    expect(ds).toMatchObject({ manual: true, encoding: "utf-8", license: { name: "CC BY 4.0" } });
    expect(ds.download).toBeUndefined();
    expect(MANBYO_CREDIT?.credit).toContain("万病辞書");
  });
  it("見出しの行と 6 項目の行を取り込み、sources に残る。出現形は全角のまま", () => {
    const { db, rejected } = build("ok", [HEADER, ...ROWS]);
    expect(rejected).toEqual([]);
    expect(db.prepare("SELECT dataset, snapshot, tbl, rows FROM sources").all()).toEqual([{ dataset: "manbyo", snapshot: "20210602", tbl: "manbyo", rows: ROWS.length }]);
    expect(db.prepare("SELECT surface, name, reliability FROM manbyo WHERE surface = 'ＡＦ'").get()).toEqual({ surface: "ＡＦ", name: "心房細動", reliability: "C" });
  });
  it("見出しが違う・項目数が違う・信頼度が S〜F でない・UTF-8 として読めないファイルは取り込まず、理由を残す", () => {
    expect(build("head", ["出現形,よみ,ICD,病名,信頼度,頻度", ...ROWS]).rejected.map((r) => r.reason)).toEqual(["1 行目：見出しの行が仕様と違う"]);
    expect(build("fields", [HEADER, "ＡＦ,えーえふ,I489,心房細動,C"]).rejected.map((r) => r.reason)).toEqual(["2 行目：項目数が合わない（仕様は 6 項目）"]);
    expect(build("rel", [HEADER, "ＡＦ,えーえふ,I489,心房細動,Z,5-10%"]).rejected.map((r) => r.reason)).toEqual(["2 行目：項番 5（信頼度レベル）の値が仕様の形と違う"]);
    expect(build("enc", [], Buffer.from([0x82, 0xa0, 0xff, 0xfe, 0x0a])).rejected.map((r) => r.reason)).toEqual(["UTF-8 として読めない"]);
  });
});

describe("出典の表示", () => {
  it("取り込んであると、設定の「マスターの状態」に万病辞書の出典（CC BY 4.0）が出る", () => {
    const { db } = build("status", [HEADER, ...ROWS]);
    const dir = path.join(tmp, "status-db");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "masters.db"), db.serialize());
    const before = process.env.RESEMEN_MASTER_DIR;
    process.env.RESEMEN_MASTER_DIR = dir;
    try {
      expect(mastersStatus().licenses).toEqual([{ dataset: "manbyo", title: "万病辞書 MANBYO", name: "CC BY 4.0", url: MANBYO_CREDIT!.url, credit: MANBYO_CREDIT!.credit }]);
    } finally {
      if (before === undefined) delete process.env.RESEMEN_MASTER_DIR;
      else process.env.RESEMEN_MASTER_DIR = before;
    }
  });
});

describe("意味の候補", () => {
  it("「;」の複数の意味を分け、「-1」と空は意味なし。大文字と小文字を分ける（AF＝心房細動、Af＝心室細動）。英字の略語の形だけを引く", () => {
    expect(meaningsOf("心臓破裂;心筋梗塞")).toEqual(["心臓破裂", "心筋梗塞"]);
    expect(meaningsOf("-1")).toEqual([]);
    expect(meaningsOf("")).toEqual([]);
    const m = manbyoOf(build("look", [HEADER, ...ROWS]).db)!;
    expect(m.get("AF")?.meanings).toEqual(["心房細動"]);
    expect(m.get("Af")?.meanings).toEqual(["心室細動"]);
    expect(m.get("AMI")?.meanings).toEqual(["心臓破裂", "心筋梗塞"]);
    expect(m.has("発熱")).toBe(false);
    // 出現形があっても意味なしの語（ADL・XY）は、辞書にない語として扱う
    expect(candidatesOf("ADL", m, []).inDict).toBe(false);
    expect(candidatesOf("XY", m, []).inDict).toBe(false);
    expect(candidatesOf("AF", m, [])).toEqual({ inDict: true, candidates: [{ meaning: "心房細動", source: "万病辞書", reliability: "C" }] });
    // クリニックの辞書の意味は後ろに並ぶ（同じ意味は 1 回）
    expect(candidatesOf("AF", m, ["心房細動", "心房粗動"]).candidates.map((c) => [c.meaning, c.source])).toEqual([
      ["心房細動", "万病辞書"],
      ["心房粗動", "クリニックの辞書"],
    ]);
    expect(candidatesOf("DOAC", m, ["直接経口抗凝固薬"])).toEqual({ inDict: true, candidates: [{ meaning: "直接経口抗凝固薬", source: "クリニックの辞書" }] });
    expect(manbyoOf(null)).toBeNull();
  });
});
