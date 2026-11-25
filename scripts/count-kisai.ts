// 設計 v36 の新しい点検の件数だけを数える（design.md §17-6 の 6。呼び出し側が手元の請求で数える）。数え方は src/generic/kisai-count.ts
// 使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/count-kisai.ts <UKE のファイル…>
// 出すのは件数だけ：G07.form（確定）・G07.form_day00・G07.form_future・G07.missing_any（条件区分 03）と、記載が要ることがある項目（条件区分 00）の数。
// 中身（文字データ）・氏名・番号・コードの値は出さない。何も保存しない
import { readFileSync } from "node:fs";
import { countKisai } from "../src/generic/kisai-count";
import { mastersDbPath, openMasters } from "../src/masters/db";
import { parseUke } from "../src/uke/uke";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/count-kisai.ts <UKE のファイル…>");
  process.exit(1);
}
const db = openMasters(mastersDbPath());
if (db === null) {
  console.error("masters.db がありません（RESEMEN_MASTER_DIR を確かめてください）");
  process.exit(1);
}
const total = countKisai(files.map((f) => parseUke(readFileSync(f))), db);
console.log(`読んだレセプト ${total.claims} 件（読めない ${total.unreadable} 件・診療年月に版がない ${total.noRevision} 件・その世代のコメント関連テーブルがない ${total.noTable} 件）`);
console.log(`G07.form（確定）${total.form} 件／G07.form_day00 ${total.formDay00} 件／G07.form_future ${total.formFuture} 件（R17 と重なって出さなかった形の指摘 ${total.formDuplicate} 件）`);
console.log(`G07.missing_any（条件区分 03・項番 0237）${total.missing03} 件`);
console.log(`記載が要ることがある項目（条件区分 00）${total.conditional} 件（外した組：R17 が見ている ${total.hiddenR17}・記載がある ${total.hiddenPresent}）`);
if (total.noTable > 0) console.log("その世代のコメント関連テーブルがない請求では、00 と 0237 は数えていません（形の件数だけ）");
db.close();
