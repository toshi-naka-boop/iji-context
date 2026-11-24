// 包括の群と告示の号の対応を確かめる（design.md §19-2。段 22a）。読むだけで、何も保存しない。
// 使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/check-bundles.ts
// マスターの医科診療行為（診療年月の世代の 1 枚）から、包括対象検査の列が 2・3・5 の行を引き、群ごとに区分番号・号・コード・名前を並べる。
// D008（列 2。告示 D008 注の号 12〜51。R8-305）と D013（列 3。告示 D013 注の号 3〜14。R8-307）について、
// (a) 群の行の区分番号がすべてその区分か (b) 群の行の号がすべて告示の範囲の中か、範囲の中の号の行で群に入っていないものがないか
// (c) 版の bundles の members とマスターの群の行が 1 対 1 で合うか（検体は決めない）を見る。1 つでも外れたら終了コード 1。
// 列 5（D009）は次の版（design.md §19-2）なので、並べるだけで確かめない
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRevision } from "../src/engine/revisions";
import { openMasters, pickSnapshot, type MastersDb } from "../src/masters/db";

/** 確かめる群：マスターの包括対象検査の列の値、区分番号、告示の注の号の範囲、版の区分キーの頭 */
export type BundleGroup = { name: string; column: string; kubunNo: number; from: number; to: number; tierPrefix: string };
export const GROUPS: BundleGroup[] = [
  { name: "D008", column: "2", kubunNo: 8, from: 12, to: 51, tierPrefix: "D008_" },
  { name: "D013", column: "3", kubunNo: 13, from: 3, to: 14, tierPrefix: "D013_" },
];
/** 並べるだけの列（D009 は次の版） */
const LISTED_ONLY = ["5"];

type Row = { code: string; name: string; alpha: string; kubun_no: number; eda: number; kou: number; houkatsu_kensa: string };

/**
 * 群ごとの確かめ。members は版の bundles の members（版に群がなければ null）。
 * 戻り値の lines は人が読む行、ok は全部の群が (a)〜(c) を満たしたか
 */
export function checkBundles(db: MastersDb, snapshot: string, groups: { group: BundleGroup; members: string[] | null }[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const bad = (text: string) => {
    ok = false;
    lines.push(`  NG ${text}`);
  };
  for (const { group, members } of groups) {
    const rows = db.prepare("SELECT code, name, alpha, kubun_no, eda, kou, houkatsu_kensa FROM shinryo WHERE snapshot = ? AND houkatsu_kensa = ? ORDER BY kubun_no, kou, code").all(snapshot, group.column) as Row[];
    lines.push(`${group.name}（包括対象検査 ${group.column}。告示の号 ${group.from}〜${group.to}）：マスターの群 ${rows.length} 行`);
    // (a) 区分番号
    const otherKubun = rows.filter((r) => r.alpha !== "D" || r.kubun_no !== group.kubunNo);
    if (otherKubun.length > 0) bad(`区分番号が ${group.name} でない行：${otherKubun.map((r) => `${r.code}（${r.alpha}${String(r.kubun_no).padStart(3, "0")}）`).join("・")}`);
    else lines.push(`  OK 区分番号がすべて一致`);
    // (b) 号が範囲の中か／範囲の中の号の行で群に入っていないもの
    const outside = rows.filter((r) => r.kou < group.from || r.kou > group.to);
    if (outside.length > 0) bad(`号が範囲の外の行：${outside.map((r) => `${r.code}（号 ${r.kou}）`).join("・")}`);
    else lines.push(`  OK 号がすべて範囲の中`);
    const missing = db
      .prepare("SELECT code, name, alpha, kubun_no, eda, kou, houkatsu_kensa FROM shinryo WHERE snapshot = ? AND alpha = 'D' AND kubun_no = ? AND kou BETWEEN ? AND ? AND houkatsu_kensa <> ? ORDER BY kou, code")
      .all(snapshot, group.kubunNo, group.from, group.to, group.column) as Row[];
    if (missing.length > 0) bad(`範囲の号の行で群に入っていないもの：${missing.map((r) => `${r.code}（号 ${r.kou}・包括対象検査 ${r.houkatsu_kensa}）`).join("・")}`);
    else lines.push(`  OK 範囲の号の抜けなし`);
    // (c) 版の members と 1 対 1
    if (members === null) bad(`版の bundles に ${group.name} の群がない`);
    else {
      const master = new Set(rows.map((r) => r.code));
      const mine = new Set(members);
      const onlyMaster = [...master].filter((c) => !mine.has(c));
      const onlyMine = [...mine].filter((c) => !master.has(c));
      if (onlyMaster.length + onlyMine.length > 0 || mine.size !== members.length) bad(`版の members とマスターの群が合わない（マスターだけ：${onlyMaster.join("・") || "なし"}／版だけ：${onlyMine.join("・") || "なし"}${mine.size !== members.length ? "／版に同じコードが 2 つ" : ""}）`);
      else lines.push(`  OK 版の members とマスターの群が 1 対 1（${members.length} 行）`);
    }
  }
  for (const column of LISTED_ONLY) {
    const n = (db.prepare("SELECT count(*) AS n FROM shinryo WHERE snapshot = ? AND houkatsu_kensa = ?").get(snapshot, column) as { n: number }).n;
    lines.push(`包括対象検査 ${column}：${n} 行（次の版。確かめない）`);
  }
  return { ok, lines };
}

/** 版の bundles から、区分キーの頭で群の members を引く（なければ null） */
export const membersOf = (bundles: { members: string[]; tiers: { kubun: string }[] }[], prefix: string): string[] | null => bundles.find((b) => b.tiers.some((t) => t.kubun.startsWith(prefix)))?.members ?? null;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = openMasters();
  if (!db) {
    console.error("masters.db がありません（RESEMEN_MASTER_DIR を確かめてください）");
    process.exit(1);
  }
  const demo = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "demo.json"), "utf8")) as { yearMonth: string };
  const rev = resolveRevision(demo.yearMonth);
  const snap = pickSnapshot(db, "shinryo", demo.yearMonth, rev.generation);
  if (!snap) {
    console.error(`診療年月 ${demo.yearMonth} の世代（${rev.generation}）の医科診療行為マスターがありません`);
    process.exit(1);
  }
  const r = checkBundles(db, snap.snapshot, GROUPS.map((group) => ({ group, members: membersOf(rev.bundles, group.tierPrefix) })));
  console.log(`医科診療行為マスター ${snap.snapshot}（版 ${rev.id}）`);
  for (const l of r.lines) console.log(l);
  console.log(r.ok ? "群と号の対応：すべて合っています" : "群と号の対応：合わないところがあります");
  process.exit(r.ok ? 0 : 1);
}
