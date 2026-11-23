// テスト用：行ったことを当てる小さな masters.db（データは同梱しない。design.md §12-7）。
// tests/generic/small-masters.ts の表に、略した書き方の合成カルテ（fixtures/charts/K8〜K11-abbrev.json）が当てるコードを、EM §2-8 の症例のコードの表の名称で足す。
// 区分番号の英字は、コードの先頭 2 桁から（12＝第5部 投薬 F など。本物のマスターの値と同じ）
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ChartAct, RxChoice, RxNote, Tbl } from "../../src/chart/acts";
import { put, smallMasters } from "../generic/small-masters";

export type AbbrevEntry = { date: string; s: string; o: string; a: string; p: string; rx: string; acts: ChartAct[]; rxNotes: RxNote[]; rxChoice: RxChoice | null };
export type AbbrevChart = { claimId: string; entries: AbbrevEntry[] };
export const ABBREV_CASES = ["K8", "K9", "K10", "K11"] as const;
export const abbrevOf = (k: string): AbbrevChart => JSON.parse(readFileSync(path.join(__dirname, "..", "..", "fixtures", "charts", `${k}-abbrev.json`), "utf8")) as AbbrevChart;

const ALPHA: Record<string, string> = { "11": "C", "12": "F", "13": "G", "14": "J", "15": "K", "16": "D", "17": "E" };

/** 合成カルテが当てるコードの一覧（表・コード・名称。同じコードは 1 回） */
export function abbrevCodes(): { tbl: Tbl; code: string; name: string }[] {
  const out = new Map<string, { tbl: Tbl; code: string; name: string }>();
  for (const k of ABBREV_CASES)
    for (const e of abbrevOf(k).entries)
      for (const a of e.acts) for (const m of [a.match, ...(a.with ?? []).map((c) => c.match)]) if (m) out.set(`${m.tbl}|${m.code}`, { tbl: m.tbl, code: m.code, name: m.name });
  return [...out.values()];
}

/** smallMasters に、合成カルテのコードを足した masters.db（file を省くとメモリの中） */
export function chartMasters(file = ":memory:", snapshot = "20261001"): Database.Database {
  const db = smallMasters(file, snapshot);
  for (const c of abbrevCodes()) {
    const has = db.prepare(`SELECT 1 FROM ${c.tbl} WHERE snapshot = ? AND code = ?`).get(snapshot, c.code);
    if (has) db.prepare(`UPDATE ${c.tbl} SET name = ? WHERE snapshot = ? AND code = ?`).run(c.name, snapshot, c.code);
    else put(db, c.tbl, snapshot, c.tbl === "shinryo" ? { code: c.code, name: c.name, alpha: ALPHA[c.code.slice(0, 2)] ?? "*" } : { code: c.code, name: c.name });
  }
  return db;
}
