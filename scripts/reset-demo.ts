// デモの撮影前に、データを決まった状態へ戻す。`npx tsx scripts/reset-demo.ts`（消す前に一覧だけ出す）→ `--yes` で実行
// 戻す先：DB なし（起動時に作り直す）・医師確認の記録なし・知識は制度層（基準月の版のルール）の初期投入だけ・一人ひとりの作業場所なし。
// 開発サーバーは DB を開いたままにするので、実行したらサーバーを起動し直す
// `--retire-stale`：データの版の印（config/demo.json の dataset）が今と違うクリニックの置き場を、改名して退避する（消さない）。
// 一覧だけ出し、`--yes` を付けたときだけ改名する。退避したクリニックは、次に開いたときに今の印で作り直される（design.md §10 段 2）
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isKnownKubun } from "../src/engine/codes-fictional";
import { workspaceRoot } from "../src/mentor/workspace";
import { retireDir, staleTenants } from "../src/server/dataset";
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
  // ログインした人ごとのクリニック（FR-73）。利用者（auth.db）は残し、次に開いたときに作り直す
  const tenants = path.join(root, "data", "tenants");
  if (existsSync(tenants)) out.push(tenants);
  const ws = workspaceRoot();
  if (existsSync(ws)) out.push(ws);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes("--retire-stale")) {
  const dataDir = path.resolve(process.env.RESEMEN_DATA ?? path.join(root, "data"));
  const stale = staleTenants(path.join(dataDir, "tenants"));
  console.log(stale.length ? `印が違う置き場（${stale.length} 件）：\n${stale.map((t) => `  ${t.dir}（印：${t.stamp ?? "なし"}）`).join("\n")}` : "印が違う置き場はない");
  if (!process.argv.includes("--yes")) console.log("\n確認だけ（--yes を付けると、改名して退避する。消さない）");
  else for (const t of stale) console.log(`退避: ${retireDir(t.dir)}`);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const list = targets();
  console.log(list.length ? `消すもの（${list.length} 件）：\n${list.map((p) => `  ${path.relative(root, p) || p}`).join("\n")}` : "消すものはない");
  if (!process.argv.includes("--yes")) {
    console.log("\n確認だけ（--yes を付けると実行する）");
  } else {
    for (const p of list) rmSync(p, { recursive: true, force: true });
    const store = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, ".claude", "skills"), knownKubun: isKnownKubun };
    const made = seed(store);
    const s = syncSkills(store);
    console.log(`\n戻しました。知識 ${made.length} 件を初期投入し、Skill を同期（世代 ${s.generation}）。開発サーバーを起動し直してください`);
  }
}
