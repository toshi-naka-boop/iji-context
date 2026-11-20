// 精度を数字で見る（design.md §12-6）：UKE のファイルを読み、データで動く点検と、ルールごとの partial の数を、レセプトごと・合計で出す。
// 使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/measure-generic.ts <UKE のファイル…>
// 出すのは数だけ（患者の氏名・番号は出さない。レセプトは、ファイルの中の通し番号と診療年月で示す）。何も保存しない。
// 段 10b で数えるもの：識別できた行の割合（マスターで名前が付いた行／全部の行）、partial になったルールの割合、v23 の定義（対象外の単位が 1 つでもあれば、どのルールも partial）との比較、点検ごとの指摘の数。
// あとの段が、ここに数を足す（検算できた単位の割合と合った割合＝段 11、など）
import { readFileSync } from "node:fs";
import path from "node:path";
import { partialBy } from "../src/engine";
import { hasRevision, resolveRevision } from "../src/engine/revisions";
import { evaluateGeneric } from "../src/generic";
import { outsideOf, rowNamesOf } from "../src/generic/lookup";
import { GENERIC_CHECKS } from "../src/generic/types";
import { mastersDbPath, openMasters } from "../src/masters/db";
import { mapClaim, parseUke, UkeError } from "../src/uke/uke";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/measure-generic.ts <UKE のファイル…>");
  process.exit(1);
}
const db = openMasters();
if (!db) {
  console.error(`masters.db がない（${mastersDbPath()}）。RESEMEN_MASTER_DIR に、masters.db のあるフォルダを渡してください（作り方は docs/masters.md）`);
  process.exit(1);
}

const KINDS = ["SI", "IY", "TO"] as const;
/** 点検を動かさなかった理由（GenericNotRun.reason）の呼び名 */
const WHY: Record<string, string> = { noMasters: "マスターがない", notReady: "準備ができていない", noSnapshot: "診療年月の世代の 1 枚がない", notBuilt: "まだ入っていない" };
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const frac = (n: number, d: number) => `${n}/${d}（${pct(n, d)}）`;

const total = {
  claims: 0,
  skipped: { 読めないレセプト: 0, 版のない診療年月: 0 },
  unreadableFiles: 0,
  rows: { SI: [0, 0], IY: [0, 0], TO: [0, 0] } as Record<(typeof KINDS)[number], [named: number, all: number]>,
  /** ルール id → partial になったレセプトの数 */
  partial: new Map<string, number>(),
  /** ルール id → その版にそのルールがあるレセプトの数 */
  ruleClaims: new Map<string, number>(),
  /** v23 の定義で partial だったレセプトの数と、そのときに止まる（ルール × レセプト）の組の数 */
  v23: 0,
  v23Pairs: 0,
  anyPartial: 0,
  allPartial: 0,
  findings: new Map<string, { 確定: number; 条件つき: number }>(),
  ran: new Map<string, number>(),
  notRun: new Map<string, number>(),
};
const add = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

for (const f of files) {
  const name = path.basename(f);
  let claims;
  try {
    claims = parseUke(readFileSync(f)).claims;
  } catch (e) {
    if (!(e instanceof UkeError)) throw e;
    total.unreadableFiles++;
    console.log(`${name}：読めないファイル（${e.message}）`);
    continue;
  }
  claims.forEach((claim, i) => {
    const id = `${name} #${i + 1}（診療年月 ${claim.yearMonth}）`;
    if (claim.unsupported !== undefined) {
      total.skipped.読めないレセプト++;
      console.log(`${id}：数えない（${claim.unsupported}）`);
      return;
    }
    if (!hasRevision(claim.yearMonth)) {
      total.skipped.版のない診療年月++;
      console.log(`${id}：数えない（この診療年月の版がない）`);
      return;
    }
    total.claims++;
    const rev = resolveRevision(claim.yearMonth);
    const about = { yearMonth: claim.yearMonth, generation: rev.generation };
    // 識別できた行
    const items = claim.units.flatMap((u) => u.items);
    const names = rowNamesOf(db, about, { items, comments: [], diseases: [] });
    const rows = KINDS.map((k) => {
      const mine = items.filter((it) => it.kind === k);
      const named = mine.filter((it) => names.items[it.code] !== undefined).length;
      total.rows[k][0] += named;
      total.rows[k][1] += mine.length;
      return `${k} ${named}/${mine.length}`;
    });
    // partial：v23 は、対象外の単位が 1 つでもあれば、どのルールも。v24 は、ルールごと
    const mapped = mapClaim(claim, rev);
    const others = mapped.others.length;
    const ctx = { partial: others > 0, outside: others > 0 ? outsideOf(db, rev, claim.yearMonth, mapped.others.flatMap((o) => o.codes)) : undefined };
    const stopped = rev.rules.filter((rule) => partialBy(rule, rev, ctx) !== null).map((rule) => rule.id);
    for (const rule of rev.rules) add(total.ruleClaims, rule.id);
    for (const ruleId of stopped) add(total.partial, ruleId);
    if (others > 0) {
      total.v23++;
      total.v23Pairs += rev.rules.length;
    }
    if (stopped.length > 0) total.anyPartial++;
    if (stopped.length === rev.rules.length) total.allPartial++;
    // データで動く点検
    const g = evaluateGeneric(claim, db, about);
    for (const r of g.ran) add(total.ran, r.check);
    for (const n of g.notRun) add(total.notRun, `${n.check}:${n.reason}`);
    for (const x of g.findings) {
      const c = total.findings.get(x.check) ?? { 確定: 0, 条件つき: 0 };
      c[x.certainty]++;
      total.findings.set(x.check, c);
    }
    const sure = g.findings.filter((x) => x.certainty === "確定").length;
    console.log(`${id}：名前が付いた行 ${rows.join("・")}／対象外の単位 ${others}／partial のルール ${stopped.length}/${rev.rules.length}（v23 の定義では ${others > 0 ? rev.rules.length : 0}/${rev.rules.length}）${stopped.length > 0 && stopped.length < rev.rules.length ? `［${stopped.join(" ")}］` : ""}／指摘 確定 ${sure}・条件つき ${g.findings.length - sure}`);
  });
}
db.close();

console.log("");
console.log(`== 合計：${total.claims} 件のレセプト（数えなかったもの：読めないレセプト ${total.skipped.読めないレセプト} 件、版のない診療年月 ${total.skipped.版のない診療年月} 件、読めないファイル ${total.unreadableFiles} 本）`);
const named = KINDS.reduce((s, k) => s + total.rows[k][0], 0);
const all = KINDS.reduce((s, k) => s + total.rows[k][1], 0);
console.log(`識別できた行の割合（マスターで名前が付いた行／全部の行）：${frac(named, all)}　${KINDS.map((k) => `${k} ${frac(...total.rows[k])}`).join("　")}`);
console.log(`partial になったレセプト：v23 の定義（対象外の単位が 1 つでもあれば、どのルールも止まる）${frac(total.v23, total.claims)}`);
console.log(`　　　　　　　　　　　　 v24（ルールごと）：1 つ以上のルールが止まる ${frac(total.anyPartial, total.claims)}、どのルールも止まる ${frac(total.allPartial, total.claims)}`);
const pairs = [...total.ruleClaims.values()].reduce((s, n) => s + n, 0);
console.log(`partial になった（ルール × レセプト）の組：v24 ${frac([...total.partial.values()].reduce((s, n) => s + n, 0), pairs)}　v23 の定義 ${frac(total.v23Pairs, pairs)}`);
console.log("partial になったルールの割合（ルールごと。partial になったレセプト／そのルールがある版のレセプト）：");
for (const [ruleId, n] of total.ruleClaims) console.log(`  ${ruleId} ${frac(total.partial.get(ruleId) ?? 0, n)}`);
console.log("点検ごとの指摘の数（確定・条件つき）と、動いたレセプトの数：");
for (const { id, kind } of GENERIC_CHECKS) {
  const c = total.findings.get(id) ?? { 確定: 0, 条件つき: 0 };
  const not = [...total.notRun].filter(([k]) => k.startsWith(`${id}:`)).map(([k, n]) => `${WHY[k.slice(id.length + 1)]} ${n} 件`);
  console.log(`  ${id}（${kind}）：確定 ${c.確定}・条件つき ${c.条件つき}／動いた ${total.ran.get(id) ?? 0} 件${not.length > 0 ? `／動かさなかった（${not.join("、")}）` : ""}`);
}
