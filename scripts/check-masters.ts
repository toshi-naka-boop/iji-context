// 今ある masters.db を、採用値のファイル（EM §2-11）で確かめ直す（design.md §12-1）。`npm run check:masters`
// 見ること：錨／値ごとの件数／版の表（Revision の points・codes）との食い違い（以前の scripts/check-codes.ts の検査。src/masters/revision-check.ts）。
// masters.db がなければ「データがないので飛ばした」と出して終了コード 0（CI にはデータがない）。1 つでも外れたら終了コード 1
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mastersDbPath, openMasters } from "../src/masters/db";
import { readEm, verifyMasters } from "../src/masters/verify";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = openMasters();
if (!db) {
  console.log(`masters.db がない（${mastersDbPath()}）。データがないので飛ばした`);
  process.exit(0);
}
const result = verifyMasters(db, readEm(root), { write: false });
db.close();
for (const line of result.lines) console.log(line);
console.log(result.failures === 0 ? `masters.db を確かめた（失敗 0 件、警告 ${result.warnings} 件）` : `失敗：${result.failures} 件`);
process.exit(result.failures > 0 ? 1 : 0);
