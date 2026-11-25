// 今ある平文のデータを、鍵で暗号化して移す（spec FR-217）。アプリを止めてから、手で流す。
// 使い方: RESEMEN_DATA=/data RESEMEN_DATA_KEY=<16 進 64 文字> npx tsx scripts/encrypt-at-rest.ts --dry-run   （対象の一覧だけ。何も変えない）
//         RESEMEN_DATA=/data RESEMEN_DATA_KEY=<16 進 64 文字> npx tsx scripts/encrypt-at-rest.ts [--backup <控えの場所>]
// 流す前に、データの置き場を丸ごと控える（既定は <置き場>.backup-<日時>。置き場の外）。控えは平文のままなので、鍵つきの起動を確かめてから消す。
// 鍵はコマンドの引数に書かない（シェルの履歴に残るため）。環境変数で渡す
import path from "node:path";
import { fileURLToPath } from "node:url";
import { masterKey } from "../src/db/key";
import { atRestTargets } from "../src/server/at-rest";
import { backupData, defaultBackupOf, encryptAll, hasWork, planMove, type TranscriptSink } from "../src/server/at-rest-move";
import { defaultPaths, openApp } from "../src/server/app";
import { dataDir, getAuth } from "../src/server/auth-db";
import { tenantPaths } from "../src/server/instance";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const data = dataDir();
  const master = masterKey();
  if (!master) throw new Error("鍵（RESEMEN_DATA_KEY。16 進 64 文字）を環境変数で渡してください");
  const targets = atRestTargets(data, root);
  const plan = planMove(targets, data);
  const rel = (f: string) => path.relative(data, f) || f;
  console.log(`データの置き場: ${data}`);
  console.log(`データベース（暗号化する ${plan.dbs.filter((d) => d.state === "plain").length} 件・済み ${plan.dbs.filter((d) => d.state === "encrypted").length} 件）`);
  for (const d of plan.dbs) console.log(`  ${d.state === "plain" ? "暗号化する" : "済み　　　"} ${rel(d.file)}`);
  console.log(`ファイル（包む ${plan.files.filter((f) => f.state === "plain").length} 件・済み ${plan.files.filter((f) => f.state === "sealed").length} 件）`);
  for (const f of plan.files) console.log(`  ${f.state === "plain" ? "包む　　　" : "済み　　　"} ${rel(f.file)}`);
  console.log(`前の版の会話の記録（app.db に写して消す ${plan.transcripts.filter((t) => t.tenant).length} 件・クリニックに当てられない ${plan.transcripts.filter((t) => !t.tenant).length} 件）`);
  for (const t of plan.transcripts) console.log(`  ${t.tenant ? `写す（${t.tenant}）` : "当てられない"} ${rel(t.file)}`);
  if (process.argv.includes("--dry-run")) {
    console.log("\n確認だけ（--dry-run）。何も変えていません");
    return;
  }
  if (!hasWork(plan)) {
    // 二度目に流したとき：済んだものが今の鍵で開けることだけ確かめる（控えは取らない・何も書き換えない）
    await encryptAll(data, root, master, null);
    console.log("\n移すものはありません（済んだものは、今の鍵で開けることを確かめました）");
    return;
  }
  const backup = backupData(data, arg("--backup") ?? defaultBackupOf(data), targets.outside);
  console.log(`\n控えを取った: ${backup}（平文のままです。鍵つきの起動を確かめてから消してください）`);
  const sink: TranscriptSink = (tenant) => {
    const app = tenant === "default" ? openApp(defaultPaths(root)) : openApp(tenantPaths(tenant), { kind: getAuth().tenantKind(tenant), decidedAt: getAuth().tenantDecidedAt(tenant) });
    return { append: (k, e) => app.sessionStore.append(k, e), load: (k) => app.sessionStore.load(k), close: () => app.close() };
  };
  const r = await encryptAll(data, root, master, sink, (l) => console.log(l));
  console.log(`\n移した：データベース ${r.dbs.filter((d) => d.done === "encrypted").length} 件・ファイル ${r.files.filter((f) => f.done === "sealed").length} 件・会話の記録 ${r.transcripts.length} 件`);
  for (const d of r.dbs) console.log(`  ${rel(d.file)}：スキーマの版 ${d.summary.version}・表 ${Object.keys(d.summary.counts).length}・行 ${Object.values(d.summary.counts).reduce((a, b) => a + b, 0)}`);
  if (r.skipped.length > 0) console.log(`\nクリニックに当てられない会話の記録が ${r.skipped.length} 件あります。中身を確かめて、要らなければ消してください（残っている間は、鍵つきでは起動しません）`);
}

main().catch((e) => {
  console.error(`止めました: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
