// 保存した AI の出力（eval/runs/<run-id>/results.jsonl の取り出し）を、LLM なしで今の候補の並べ方に掛け直して数える（design.md §15-10 段 18d。round-63 C-394）。
// 数え方は 1 対 1（L-163。eval/acts-count.ts）。マスター（RESEMEN_MASTER_DIR）が要る。
// 20 件に入る数が線（48/74）以上で、eval/replay-baseline.json の正解（v31 の並べ方で入っていたもの）の退行が 0 なら 0 で終わる。満たさなければ 1
// 使い方：npx tsx scripts/replay-acts.ts [run-id]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countActs, loadExclude, matchSaved, wantOf, type SavedAct } from "../eval/acts-count";
import type { ChartAct } from "../src/chart/acts";
import { withMasters } from "../src/masters/db";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 再生の線（設計の値。段 18d） */
const REPLAY_MIN_IN20 = 48;

type Case = { id: string; kind: string; split?: string; chart?: string; date?: string };
type Saved = { id: string; output: { got?: SavedAct[]; misses?: { got: SavedAct[] }[] } };
type Baseline = { run: string; hits: string[] };

const baseline = JSON.parse(readFileSync(path.join(root, "eval", "replay-baseline.json"), "utf8")) as Baseline;
/** 既定の run は基準のファイルが持つ run（日付をコードに直書きしない） */
const runId = process.argv[2] ?? baseline.run;
const cases = new Map(
  readFileSync(path.join(root, "eval", "datasets", "resemen.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case)
    .filter((c) => c.kind === "acts")
    .map((c) => [c.id, c]),
);
const saved = readFileSync(path.join(root, "eval", "runs", runId, "results.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Saved)
  .filter((r) => cases.has(r.id));

const code = withMasters((db) => {
  if (!db) {
    console.error("masters.db がない（RESEMEN_MASTER_DIR）");
    return 1;
  }
  const t = { total: 0, in20: 0, top5: 0, ref: 0, refIn20: 0, refTop5: 0, extra: 0, ruleTaken: 0 };
  // 除く正解（規則・患者の情報で出すもの。design.md §16-9）は ID で持つ
  const exclude = loadExclude(root);
  const hits: string[] = [];
  for (const r of saved) {
    const c = cases.get(r.id)!;
    const chart = JSON.parse(readFileSync(path.join(root, "fixtures", "charts", `${c.chart}-abbrev.json`), "utf8")) as { entries: { date: string; acts: ChartAct[] }[] };
    const e = chart.entries.find((x) => x.date === c.date);
    const got = r.output.got ?? r.output.misses?.[0]?.got;
    if (!e || !got) throw new Error(`${r.id}：記載か保存した取り出しがない`);
    const want = wantOf(e.acts, { chart: c.chart!, date: c.date! });
    const n = countActs(matchSaved(db, e.date.slice(0, 7), got), want, exclude);
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += n[k];
    hits.push(...n.hits.map((wi) => `${r.id}#${wi}:${want[wi].code}`));
  }
  const lost = baseline.run === runId ? baseline.hits.filter((h) => !hits.includes(h)) : [];
  const gained = baseline.run === runId ? hits.filter((h) => !baseline.hits.includes(h)) : [];
  const pct = (a: number, b: number) => `${b ? Math.round((a / b) * 1000) / 10 : 0}%`;
  console.log(`再生 ${runId}（${saved.length} 記載。1 対 1）`);
  console.log(`- 20 件に入った ${t.in20}/${t.total}（${pct(t.in20, t.total)}。線 ${REPLAY_MIN_IN20}）、上位 5 件 ${t.top5}/${t.total}（${pct(t.top5, t.total)}）`);
  console.log(`- 文章から取り出すべき行為（規則・患者の情報で出す除く正解 ${t.total - t.ref} 個を外した ${t.ref} 行為。design.md §16-9）：20 件 ${t.refIn20}/${t.ref}（${pct(t.refIn20, t.ref)}）、上位 5 件 ${t.refTop5}/${t.ref}（${pct(t.refTop5, t.ref)}）`);
  console.log(`- 余計な取り出し ${t.extra}・規則で出すものを取り出した数 ${t.ruleTaken}（線にしない）`);
  if (baseline.run !== runId) console.log(`- 退行：比べない（基準は ${baseline.run} の再生）`);
  else console.log(`- 基準（${baseline.hits.length} 個）からの退行 ${lost.length}${lost.length ? `：${lost.join("、")}` : ""}、新しく入った ${gained.length}`);
  return t.in20 >= REPLAY_MIN_IN20 && lost.length === 0 ? 0 : 1;
});
process.exit(code);
