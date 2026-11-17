// データの版の印（design.md §10 段 2）。症例・UKE・知識の種を全面的に入れ替えたとき、古いデータの置き場を見分けるためのもの。
// 置き場（SQLite と knowledge/ の組。公開版は tenant ごと）に、作ったときの印（config/demo.json の dataset）を残す。
// 印が違う置き場を開いても、止めない・作り直さない・退避しない。警告を記録して開くだけ。
// 退避（置き場を改名して残す）と作り直しは、承認を取ってから scripts/reset-demo.ts で行う
import Database from "better-sqlite3";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { period } from "../demo/period";

const KEY = "dataset";
/** 監査ログに残す操作の名前 */
export const DATASET_MISMATCH = "dataset.mismatch";

export type DatasetState = { stamp: string | null; current: string; ok: boolean };

const stampOf = (sqlite: Database.Database): string | null =>
  (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined)?.value ?? null;

/**
 * 置き場を開いたときに呼ぶ。新しく作った置き場（fresh）には今の印を付ける。
 * すでにある置き場の印が今の設定と違えば（印がないものを含む）、警告を監査ログに 1 回だけ残す。データには触らない
 */
export function checkDataset(sqlite: Database.Database, fresh: boolean, current: string = period.dataset): DatasetState {
  if (fresh) {
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, current);
    return { stamp: current, current, ok: true };
  }
  const stamp = stampOf(sqlite);
  if (stamp === current) return { stamp, current, ok: true };
  const target = `${stamp ?? "印なし"} / ${current}`;
  const seen = sqlite.prepare("SELECT 1 FROM audit_log WHERE action = ? AND target = ? LIMIT 1").get(DATASET_MISMATCH, target);
  if (!seen) {
    sqlite
      .prepare("INSERT INTO audit_log (at, demo_now, user_id, role, action, target, result, status) VALUES (?, NULL, 'system', 'system', ?, ?, 'error', 0)")
      .run(new Date().toISOString(), DATASET_MISMATCH, target);
    console.warn(`[dataset] データの版の印が設定と違う置き場を開いた（${target}）。作り直しは scripts/reset-demo.ts --retire-stale で、承認を取ってから行う`);
  }
  return { stamp, current, ok: false };
}

/** 置き場の DB から印だけを読む（開いて用意はしない）。DB がなければ null */
export function readStamp(dbFile: string): string | null {
  if (!existsSync(dbFile)) return null;
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return stampOf(sqlite);
  } catch {
    return null;
  } finally {
    sqlite.close();
  }
}

/** 印が今の設定と違うクリニック（tenant）の置き場の一覧 */
export function staleTenants(tenantsDir: string, current: string = period.dataset): { dir: string; stamp: string | null }[] {
  if (!existsSync(tenantsDir)) return [];
  return readdirSync(tenantsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^t[0-9a-f]{12}$/.test(e.name))
    .map((e) => ({ dir: path.join(tenantsDir, e.name), stamp: readStamp(path.join(tenantsDir, e.name, "app.db")) }))
    .filter((t) => t.stamp !== current);
}

/** 置き場を改名して退避する（消さない）。改名先のパスを返す。次に開いたとき、元の場所に新しい置き場が今の印で作られる */
export function retireDir(dir: string, at: Date = new Date()): string {
  const tag = at.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  let to = `${dir}.retired-${tag}`;
  for (let i = 2; existsSync(to); i++) to = `${dir}.retired-${tag}-${i}`;
  renameSync(dir, to);
  return to;
}
