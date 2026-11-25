// 鍵の入れ替え（spec FR-218）。アプリを止めてから、手で流す。全部のデータベースの鍵を変え、ファイルを包み直す。自動の入れ替えはない。
// 使い方: RESEMEN_DATA=/data RESEMEN_DATA_KEY=<今の鍵> RESEMEN_NEW_DATA_KEY=<新しい鍵> npx tsx scripts/rotate-key.ts --dry-run   （対象の一覧だけ）
//         RESEMEN_DATA=/data RESEMEN_DATA_KEY=<今の鍵> RESEMEN_NEW_DATA_KEY=<新しい鍵> npx tsx scripts/rotate-key.ts [--backup <控えの場所>]
// 流す前に、データの置き場を丸ごと控える（今の鍵で暗号化したまま）。入れ替えたあとは、新しい鍵を RESEMEN_DATA_KEY にして起動する
import path from "node:path";
import { fileURLToPath } from "node:url";
import { masterKey } from "../src/db/key";
import { atRestTargets } from "../src/server/at-rest";
import { backupData, defaultBackupOf, planMove, rotateAll } from "../src/server/at-rest-move";
import { dataDir } from "../src/server/auth-db";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

try {
  const data = dataDir();
  const from = masterKey();
  const to = masterKey({ RESEMEN_DATA_KEY: process.env.RESEMEN_NEW_DATA_KEY });
  if (!from || !to) throw new Error("今の鍵（RESEMEN_DATA_KEY）と新しい鍵（RESEMEN_NEW_DATA_KEY）を、どちらも 16 進 64 文字で環境変数に渡してください");
  const targets = atRestTargets(data, root);
  const plan = planMove(targets, data);
  console.log(`データの置き場: ${data}\n鍵を変えるデータベース ${plan.dbs.length} 件・包み直すファイル ${plan.files.length} 件`);
  for (const f of [...plan.dbs.map((d) => d.file), ...plan.files.map((x) => x.file)]) console.log(`  ${path.relative(data, f) || f}`);
  if (process.argv.includes("--dry-run")) {
    console.log("\n確認だけ（--dry-run）。何も変えていません");
  } else {
    const backup = backupData(data, arg("--backup") ?? defaultBackupOf(data), targets.outside);
    console.log(`\n控えを取った: ${backup}（今の鍵で暗号化したまま）`);
    rotateAll(data, root, from, to, (l) => console.log(l));
    console.log("新しい鍵を RESEMEN_DATA_KEY にして起動し、開けることを確かめてください。古い鍵の控えは、控え（上）を消すまで残してください");
  }
} catch (e) {
  console.error(`止めました: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
