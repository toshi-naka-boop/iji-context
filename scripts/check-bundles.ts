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
import { checkBundles, GROUPS, membersOf } from "../src/masters/bundle-check";
import { openMasters, pickSnapshot } from "../src/masters/db";

export { checkBundles, GROUPS, membersOf, type BundleGroup } from "../src/masters/bundle-check";

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
