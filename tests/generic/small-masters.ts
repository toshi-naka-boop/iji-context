// テスト用：手で作った数行の masters.db（データは同梱しない。design.md §12-7）。
// 使うのは EM に採用済みのコードだけ（診療行為は版のコードの表＝EM §2-8、医薬品・特定器材は錨 A22・A23、コメントは EM §2-10、傷病名は EM §2-8「傷病名」）。
// 名称は版の点数表の名称か、ここで付けた仮の名称で、公開元の表の行は写していない。区分番号は、版の点数表の区分番号の表示（"C001 1 イ" → 区分番号 1）から作る
import Database from "better-sqlite3";
import { r2026 } from "../../src/engine/revisions/r2026";
import { createSchema } from "../../src/masters/build";

export const GEN = "R8";
/** 医薬品・特定器材（EM §2-11 の錨 A22・A23 のコード）、コメント（EM §2-10 表 1）、傷病名（EM §2-8） */
export const DRUG = "630010002";
export const DEVICE = "700080000";
export const COMMENT = "850100106";
export const DISEASE = "4289018";

/** 表の 1 行を足す。挙げなかった列は、文字なら空・数なら 0 */
export function put(db: Database.Database, table: string, snapshot: string, row: Record<string, string | number>): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, value: c.name === "snapshot" ? snapshot : (row[c.name] ?? (c.type === "TEXT" ? "" : 0)) }));
  db.prepare(`INSERT INTO ${table} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => c.value));
}

/** その表の 1 枚（更新日）を持っていることにする */
export function source(db: Database.Database, table: string, snapshot: string, generation = GEN): void {
  db.prepare("INSERT INTO sources (dataset, snapshot, generation, tbl, file, sha256, rows, imported_at) VALUES (?, ?, ?, ?, ?, '', 0, '')").run(table, snapshot, generation, table, `${table}_${snapshot}`);
}

/** 版のコードの表にある診療行為の 1 行。区分番号は、区分番号の表示の先頭（"C002-2" なら 区分番号 2・枝番 2）から */
export function putShinryo(db: Database.Database, snapshot: string, kubun: string, code = r2026.codes[kubun].primary): void {
  const m = /^([A-Z])(\d{3})(?:-(\d+))?$/.exec(r2026.points[kubun].no.split(" ")[0]);
  const alpha = m ? m[1] : "*";
  put(db, "shinryo", snapshot, { code, name: r2026.points[kubun].name, alpha, sho: alpha === "A" ? 1 : 2, bu: m ? "ABCDEFGHIJKLMNO".indexOf(alpha) : 0, kubun_no: m ? Number(m[2]) : 0, eda: m?.[3] ? Number(m[3]) : 0 });
}

/**
 * 小さな masters.db。file を省くとメモリの中に作る。snapshot は、基本マスター 5 本の更新日（1 枚ずつ）。
 * 入れるもの：版のコードの表の診療行為すべて、医薬品 1 つ、特定器材 1 つ、コメント 1 つ、傷病名 1 つ。G01 は準備できている、G02 は準備できていない
 */
export function smallMasters(file = ":memory:", snapshot = "20261001"): Database.Database {
  const db = new Database(file);
  createSchema(db);
  for (const t of ["shinryo", "iyakuhin", "tokutei", "comment", "shobyo"]) source(db, t, snapshot);
  for (const kubun of Object.keys(r2026.codes)) putShinryo(db, snapshot, kubun);
  put(db, "iyakuhin", snapshot, { code: DRUG, name: "手作りの医薬品" });
  put(db, "tokutei", snapshot, { code: DEVICE, name: "手作りの特定器材" });
  put(db, "comment", snapshot, { code: COMMENT, name: "手作りのコメントの定型文" });
  put(db, "shobyo", snapshot, { code: DISEASE, name: "手作りの傷病名" });
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason, missing) VALUES ('G01', 1, '', '[]'), ('G02', 0, '錨がない：手作りの表', '[]')").run();
  return db;
}
