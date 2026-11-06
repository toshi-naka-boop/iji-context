// デモの撮影前に、データを決まった状態へ戻す。`npx tsx scripts/reset-demo.ts`（消す前に一覧だけ出す）→ `--yes` で実行
// 戻す先：DB なし（起動時に作り直す）・医師確認の記録なし・知識は制度層 R01〜R14 の初期投入だけ・一人ひとりの作業場所なし。
// 開発サーバーは DB を開いたままにするので、実行したらサーバーを起動し直す
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceRoot } from "../src/mentor/workspace";
import { syncSkills } from "./sync-skills";
import { seed } from "./seed-knowledge";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function targets(): string[] {
  const out: string[] = [];
  for (const f of ["resemen.db", "resemen.db-wal", "resemen.db-shm"]) {
    const p = path.join(root, "data", f);
    if (existsSync(p)) out.push(p);
  }
  const log = path.join(root, "query-log");
  if (existsSync(log)) for (const f of readdirSync(log)) out.push(path.join(log, f));
  const k = path.join(root, "knowledge");
  if (existsSync(k)) for (const layer of readdirSync(k)) out.push(path.join(k, layer));
  const ws = workspaceRoot();
  if (existsSync(ws)) out.push(ws);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const list = targets();
  console.log(list.length ? `消すもの（${list.length} 件）：\n${list.map((p) => `  ${path.relative(root, p) || p}`).join("\n")}` : "消すものはない");
  if (!process.argv.includes("--yes")) {
    console.log("\n確認だけ（--yes を付けると実行する）");
  } else {
    for (const p of list) rmSync(p, { recursive: true, force: true });
    const store = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, ".claude", "skills") };
    const made = seed(store);
    const s = syncSkills(store);
    console.log(`\n戻しました。知識 ${made.length} 件を初期投入し、Skill を同期（世代 ${s.generation}）。開発サーバーを起動し直してください`);
  }
}
