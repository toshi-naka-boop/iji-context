// 落とした公開データから masters.db を作る（design.md §12-1）。`npm run masters:build`
// 読む場所：<データ置き場>/masters/raw/<データ名>/<更新日>/。書く場所：<データ置き場>/masters/masters.db（データ置き場は RESEMEN_DATA。既定は ./data）。
// 作りかけは別のファイルに書き、形式の検査・錨・件数・版の表との突き合わせが全部通ってから置き換える。1 つでも外れたら、今ある masters.db には触らずに終了コード 1
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { carryOver, createSchema, ingestAll } from "../src/masters/build";
import { MASTERS_CONFIG } from "../src/masters/config";
import { mastersDbPath, mastersDir } from "../src/masters/db";
import { readEm, verifyMasters } from "../src/masters/verify";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const started = Date.now();
const dir = mastersDir();
const raw = path.join(dir, "raw");
const out = mastersDbPath();
const tmp = `${out}.building`;
mkdirSync(dir, { recursive: true });
rmSync(tmp, { force: true });
console.log(`読む場所：${raw}`);
const db = new Database(tmp);
// 作りかけのファイルなので、途中で落ちたら捨てる（ジャーナルを書かない）
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");
createSchema(db);
const rejected = ingestAll(db, raw, MASTERS_CONFIG, new Date().toISOString(), console.log);
// 前の世代の 1 枚を、今ある masters.db から残す（改定の棚卸で比べる。design.md §14-4。X-125）
const carried = carryOver(db, out, MASTERS_CONFIG.generation, console.log);
const result = verifyMasters(db, readEm(root), { write: true });
for (const line of result.lines) console.log(line);
db.exec("ANALYZE");
db.close();
const sources = result.sources;
if (sources === 0) {
  rmSync(tmp, { force: true });
  console.error(`取り込めるファイルがなかった。docs/masters.md の手順で ${raw} に置く`);
  process.exit(1);
}
if (result.failures > 0) {
  rmSync(tmp, { force: true });
  console.error(`失敗：${result.failures} 件（錨・件数・版の表との食い違い）。masters.db は置き換えていない`);
  process.exit(1);
}
renameSync(tmp, out);
console.log(`${out} を作った（${(statSync(out).size / 1024 / 1024).toFixed(1)} MB、${((Date.now() - started) / 1000).toFixed(1)} 秒）。取り込まなかったファイル ${rejected.length} 件、前の世代から残した 1 枚 ${carried} 個、警告 ${result.warnings} 件`);
