// 落とした公開データから masters.db を作る（design.md §12-1）。呼ぶのは scripts/build-masters.ts と、小さな表で動かすテストだけ。
// 置き方：<データ置き場>/masters/raw/<データ名>/<更新日 8 桁>/<ファイル>。更新日ごとの 1 枚を全部取り込む（表の snapshot の列）。
// 前の世代（改定前）の 1 枚は、今ある masters.db から世代ごとにいちばん新しい 1 枚を写して残す（carryOver。design.md §14-4。X-125）。
// 形式の検査：Shift_JIS・項目数・見出しの行・取り込む項目の型と値の区分（src/masters/layout.ts）。1 行でも合わなければ、そのファイルは取り込まず、理由を rejected に残す。件数 0 も取り込まない
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MastersConfig } from "./config";
import { MasterFormatError, readCsv } from "./csv";
import { LAYOUTS, type TableLayout } from "./layout";

const sqlType = { text: "TEXT", int: "INTEGER", real: "REAL" } as const;

/** 表を作る（取り込みの前に 1 回）。データの表は layout から、管理の表（sources・rejected・checks_ready）は固定 */
export function createSchema(db: Database.Database): void {
  const made = new Set<string>();
  for (const l of LAYOUTS) {
    if (made.has(l.table)) continue;
    made.add(l.table);
    // 配列の項目は、つないだ文字の列
    const cols = [...Object.keys(l.fixed ?? {}).map((k) => `${k} INTEGER NOT NULL`), ...l.columns.map((x) => `${x.col} ${Array.isArray(x.item) ? "TEXT" : sqlType[x.type.as]} NOT NULL`)];
    db.exec(`CREATE TABLE ${l.table} (snapshot TEXT NOT NULL, ${cols.join(", ")})`);
    l.index.forEach((ix, i) => db.exec(`CREATE ${i === 0 && l.unique ? "UNIQUE " : ""}INDEX ${l.table}_${i} ON ${l.table} (snapshot, ${ix.join(", ")})`));
  }
  db.exec(`
CREATE TABLE sources (dataset TEXT NOT NULL, snapshot TEXT NOT NULL, generation TEXT NOT NULL, tbl TEXT NOT NULL, file TEXT NOT NULL, sha256 TEXT NOT NULL, rows INTEGER NOT NULL, imported_at TEXT NOT NULL, verified TEXT, PRIMARY KEY (tbl, snapshot, file));
CREATE TABLE rejected (dataset TEXT NOT NULL, snapshot TEXT NOT NULL, file TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE checks_ready (check_id TEXT PRIMARY KEY, ready INTEGER NOT NULL, reason TEXT NOT NULL);
`);
}

/**
 * ファイル 1 つを、その表の 1 枚（snapshot）として取り込む。形式が合わなければ MasterFormatError（呼び出し側のトランザクションごと取り消す）。
 * 戻り値は件数と sha256
 */
export function ingestFile(db: Database.Database, layout: TableLayout, file: string, fields: number, snapshot: string): { rows: number; sha256: string } {
  const items = layout.columns.flatMap((x) => (Array.isArray(x.item) ? x.item : [x.item]));
  if (items.some((i) => i < 1 || i > fields)) throw new Error(`レイアウト ${layout.id} の項番が、項目数 ${fields} の外`);
  const fixed = Object.entries(layout.fixed ?? {});
  const names = ["snapshot", ...fixed.map(([k]) => k), ...layout.columns.map((x) => x.col)];
  const insert = db.prepare(`INSERT INTO ${layout.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
  const head = [snapshot, ...fixed.map(([, v]) => v)];
  const loose = new Set(layout.loose ?? []);
  let rows = 0;
  const { sha256 } = readCsv(file, (cells, line) => {
    if (cells.length !== fields) throw new MasterFormatError(`項目数が合わない（仕様は ${fields} 項目）`, line);
    if (layout.header && line === 1) {
      if (cells.join("\u0000") !== layout.header.join("\u0000")) throw new MasterFormatError("見出しの行が仕様と違う", line);
      return;
    }
    const values: (string | number)[] = [...head];
    for (const col of layout.columns) {
      // 判定に使わない列は形を見ず、形に合わない値は文字のまま持つ（layout の loose）
      if (loose.has(col.col) && !Array.isArray(col.item) && !col.type.check.test(cells[col.item - 1])) {
        values.push(cells[col.item - 1]);
        continue;
      }
      const read = (item: number): string => {
        const v = cells[item - 1];
        if (!col.type.check.test(v)) throw new MasterFormatError(`項番 ${item}（${col.name}）の値が仕様の形と違う`, line);
        return v;
      };
      if (Array.isArray(col.item)) {
        const join = col.join ?? { sep: ",", empty: "" };
        const kept = col.item.map(read).filter((v) => Number(v) !== 0);
        values.push(kept.length > 0 ? kept.join(join.sep) : join.empty);
      }
      else {
        const v = read(col.item);
        values.push(col.type.as === "text" ? v : Number(v));
      }
    }
    try {
      insert.run(values);
    } catch {
      // 索引の重複（同じコードが 2 行）。SQLite のメッセージは出さない
      throw new MasterFormatError("同じコードの行が 2 つある", line);
    }
    rows++;
  });
  if (rows === 0) throw new MasterFormatError("件数が 0");
  return { rows, sha256 };
}

export type Rejected = { dataset: string; snapshot: string; file: string; reason: string };

/**
 * raw の下のファイルを全部取り込む。フォルダの名前が 8 桁の数字のものだけを更新日として読み、シンボリックリンクはたどらない。
 * 取り込めなかったファイルは、理由つきで返す（rejected の表にも残す）。log は進み具合の表示
 */
export function ingestAll(db: Database.Database, rawDir: string, config: MastersConfig, now: string, log: (line: string) => void = () => {}): Rejected[] {
  const rejected: Rejected[] = [];
  const reject = (r: Rejected) => {
    rejected.push(r);
    db.prepare("INSERT INTO rejected (dataset, snapshot, file, reason) VALUES (?, ?, ?, ?)").run(r.dataset, r.snapshot, r.file, r.reason);
    log(`  取り込まない：${r.dataset}/${r.snapshot}/${r.file}：${r.reason}`);
  };
  const entries = (dir: string, want: "dir" | "file"): string[] => {
    try {
      return readdirSync(dir).filter((n) => {
        const st = lstatSync(path.join(dir, n));
        return want === "dir" ? st.isDirectory() : st.isFile();
      }).sort();
    } catch {
      return [];
    }
  };
  const addSource = db.prepare("INSERT INTO sources (dataset, snapshot, generation, tbl, file, sha256, rows, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [dataset, ds] of Object.entries(config.datasets)) {
    for (const snapshot of entries(path.join(rawDir, dataset), "dir")) {
      if (!/^\d{8}$/.test(snapshot)) continue;
      const dir = path.join(rawDir, dataset, snapshot);
      if (ds.since !== undefined && snapshot < ds.since) {
        reject({ dataset, snapshot, file: "", reason: `世代 ${config.generation} より前の更新分（${ds.since} より前）` });
        continue;
      }
      const files = entries(dir, "file");
      for (const f of ds.files) {
        const layout = LAYOUTS.find((l) => l.id === f.layout);
        if (!layout) throw new Error(`config/masters.json の layout が src/masters/layout.ts にない: ${f.layout}`);
        const hit = files.filter((n) => new RegExp(f.name, "i").test(n));
        if (hit.length === 0) continue;
        if (hit.length > 1) {
          reject({ dataset, snapshot, file: hit.join("、"), reason: "同じ形の名前のファイルが 2 つ以上ある" });
          continue;
        }
        try {
          const r = db.transaction(() => ingestFile(db, layout, path.join(dir, hit[0]), f.fields, snapshot))();
          addSource.run(dataset, snapshot, config.generation, layout.table, hit[0], r.sha256, r.rows, now);
          log(`  ${dataset}/${snapshot}/${hit[0]} → ${layout.table}：${r.rows.toLocaleString("ja-JP")} 件`);
        } catch (e) {
          if (!(e instanceof MasterFormatError)) throw e;
          reject({ dataset, snapshot, file: hit[0], reason: e.message });
        }
      }
    }
  }
  return rejected;
}

/**
 * 前の世代の 1 枚を残す（design.md §14-4。X-125）：今ある masters.db（old）から、いまの世代（generation）でない世代ごとに、データごとのいちばん新しい 1 枚を、
 * 作っている masters.db に写す（行と sources の行。verified もそのまま）。改定の棚卸で、改定前の世代の 1 枚と改定後の世代の 1 枚を比べるため。
 * いまの世代の 1 枚は raw から作り直す（写さない）。old がない・読めない・表の形が違うときは何もしない。写した 1 枚の数を返す
 */
export function carryOver(db: Database.Database, oldFile: string, generation: string, log: (line: string) => void = () => {}): number {
  if (!existsSync(oldFile)) return 0;
  let old: Database.Database;
  try {
    old = new Database(oldFile, { readonly: true, fileMustExist: true });
  } catch {
    return 0;
  }
  try {
    const rows = old.prepare("SELECT * FROM sources WHERE generation != ?").all(generation) as { dataset: string; snapshot: string; generation: string; tbl: string; file: string; sha256: string; rows: number; imported_at: string; verified: string | null }[];
    // 世代・データごとの、いちばん新しい 1 枚
    const latest = new Map<string, string>();
    for (const r of rows) {
      const k = `${r.generation}\0${r.dataset}`;
      if ((latest.get(k) ?? "") < r.snapshot) latest.set(k, r.snapshot);
    }
    const keep = rows.filter((r) => latest.get(`${r.generation}\0${r.dataset}`) === r.snapshot);
    const has = db.prepare("SELECT 1 FROM sources WHERE tbl = ? AND snapshot = ?");
    const addSource = db.prepare("INSERT INTO sources (dataset, snapshot, generation, tbl, file, sha256, rows, imported_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let n = 0;
    for (const r of keep) {
      // いまの世代の 1 枚と同じ日の 1 枚は写さない（表の 1 枚は更新日で引くので、世代の違う同じ日の 1 枚は区別できない）
      if (has.get(r.tbl, r.snapshot)) {
        log(`  前の世代の 1 枚を写さない：${r.dataset}/${r.snapshot}（${r.generation}）は、いまの世代の 1 枚と同じ日`);
        continue;
      }
      const cols = (db.prepare(`PRAGMA table_info(${r.tbl})`).all() as { name: string }[]).map((c) => c.name);
      const oldCols = new Set((old.prepare(`PRAGMA table_info(${r.tbl})`).all() as { name: string }[]).map((c) => c.name));
      if (cols.some((c) => !oldCols.has(c))) {
        log(`  前の世代の 1 枚を写さない：${r.dataset}/${r.snapshot}（${r.generation}）は、表の列が今と違う`);
        continue;
      }
      const insert = db.prepare(`INSERT INTO ${r.tbl} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      db.transaction(() => {
        for (const row of old.prepare(`SELECT ${cols.join(", ")} FROM ${r.tbl} WHERE snapshot = ?`).iterate(r.snapshot) as Iterable<Record<string, unknown>>) insert.run(cols.map((c) => row[c]));
        addSource.run(r.dataset, r.snapshot, r.generation, r.tbl, r.file, r.sha256, r.rows, r.imported_at, r.verified);
      })();
      n++;
      log(`  前の世代の 1 枚を残した：${r.dataset}/${r.snapshot}（${r.generation}）→ ${r.tbl}：${r.rows.toLocaleString("ja-JP")} 件`);
    }
    return n;
  } catch (e) {
    if (e instanceof Database.SqliteError) return 0;
    throw e;
  } finally {
    old.close();
  }
}
