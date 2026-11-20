// 精度を数字で見る（design.md §12-6）：UKE のファイルを読み、データで動く点検と、ルールごとの partial の数を、レセプトごと・合計で出す。
// 使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/measure-generic.ts <UKE のファイル…>
// 出すのは数だけ（患者の氏名・番号は出さない。レセプトは、ファイルの中の通し番号と診療年月で示す）。何も保存しない。
// 段 10b で数えるもの：識別できた行の割合（マスターで名前が付いた行／全部の行）、partial になったルールの割合、v23 の定義（対象外の単位が 1 つでもあれば、どのルールも partial）との比較、点検ごとの指摘の数。
// 段 11 で数えるもの：検算（G02）できた単位の割合と、そのうち UKE の点数と合った割合、検算の対象外の単位の理由ごとの数、G02・G03 の指摘の数（点検ごとの指摘の数に出る）。
// 行の属性（G03）には、入院外・生年月日・施設の種別（config/facility.json が在宅療養支援診療所なら診療所）を渡す
// 段 12 で足したもの：G04〜G06 の指摘の数（言い切りの候補＝一覧に載せれば言い切りになるもの・条件つき）、手書きのルールとの重なりで出さなかった数、指摘の内訳（コードと出どころ）、点検にかかった時間。
// 手書きのルールは、取り込んだレセプトの点検と同じ条件（事実はどれも不明・カルテ側の記録なし・施設は標準の設定）で掛ける。
// あとの段が、ここに数を足す
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluate, partialBy } from "../src/engine";
import facilityJson from "../config/facility.json";
import { facilityOf, type FacilityJson } from "../src/engine/facility";
import { hasRevision, resolveRevision } from "../src/engine/revisions";
import type { ClaimContext } from "../src/engine/types";
import { evaluateGeneric } from "../src/generic";
import { recalcClaim, recalcSummary } from "../src/generic/g02";
import { outsideOf, rowNamesOf } from "../src/generic/lookup";
import { mappedLinesOf, overlap } from "../src/generic/overlap";
import { GENERIC_CHECKS, type GenericAboutMore } from "../src/generic/types";
import { mastersDbPath, openMasters } from "../src/masters/db";
import { GENERIC_TEXT_CERTAIN } from "../src/messages";
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
/** 言い切りの候補の種類（言い切りの文を持つ種類）。一覧（config/generic-checks.json）に全部載せたつもりで掛けて、候補を数える */
const CANDIDATES: ReadonlySet<string> = new Set(Object.keys(GENERIC_TEXT_CERTAIN));
const facility = facilityOf(facilityJson as FacilityJson);
/** 事実は、どれも不明 */
const unknownFacts = new Proxy({}, { get: () => ({ known: false }) }) as ClaimContext["facts"];
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
  /** 言い切りの候補（一覧に載せれば言い切りになる指摘）の数。点検ごと */
  candidates: new Map<string, number>(),
  /** 重なりの規則で出さなかった数 */
  duplicate: 0,
  judged: 0,
  /** データで動く点検にかかった時間（ミリ秒。レセプトごとの最大と合計）と、行の数の最大 */
  ms: { max: 0, sum: 0, rows: 0 },
  ran: new Map<string, number>(),
  notRun: new Map<string, number>(),
  /** 検算（G02）：点数の書いてある単位・再計算できた単位・UKE の点数と合った単位・対象外の理由ごとの数 */
  recalc: { units: 0, checked: 0, matched: 0, excluded: new Map<string, number>() },
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
    const about: GenericAboutMore = { yearMonth: claim.yearMonth, generation: rev.generation, outpatient: true, birth: claim.patient.birth, ...(facility.zaishishin === true ? { clinic: true } : {}) };
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
    const t0 = performance.now();
    const g = evaluateGeneric(claim, db, about, undefined, CANDIDATES);
    const ms = performance.now() - t0;
    total.ms = { max: Math.max(total.ms.max, ms), sum: total.ms.sum + ms, rows: Math.max(total.ms.rows, items.length) };
    for (const r of g.ran) add(total.ran, r.check);
    for (const n of g.notRun) add(total.notRun, `${n.check}:${n.reason}`);
    // 手書きのルールの結果と重ねる（取り込んだレセプトの点検と同じ条件）
    const ctx2: ClaimContext = { claimId: "measure", yearMonth: claim.yearMonth, facility, payer: "支払基金", prefecture: "", facts: unknownFacts, events: [], recordsKnown: false, lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })), comments: mapped.comments, commentsKnown: true, ...ctx };
    const o = overlap(evaluate(ctx2), rev, false, mappedLinesOf(mapped.lines, mapped.origins), g.findings);
    total.duplicate += o.duplicate;
    total.judged += o.judged;
    for (const x of o.findings) {
      if (x.certainty === "確定") add(total.candidates, x.check);
      console.log(`  ${x.check} ${x.certainty === "確定" ? "言い切りの候補" : "条件つき"} ${x.messageKey} ${x.codes.map((c) => `${c} ${names.items[c]?.name ?? ""}`).join(" × ")}［${x.source.data} ${x.source.ref}］`);
    }
    // 出荷の時点では一覧が空なので、画面に出るのは全部条件つき
    for (const x of o.findings.map((f) => ({ ...f, certainty: "条件つき" as const }))) {
      const c = total.findings.get(x.check) ?? { 確定: 0, 条件つき: 0 };
      c[x.certainty]++;
      total.findings.set(x.check, c);
    }
    const sure = 0;
    // 検算（G02 が動いたときだけ）
    const list = g.ran.some((r) => r.check === "G02") ? recalcClaim(claim, db, about) : [];
    const sum = recalcSummary(Array.isArray(list) ? list : []);
    total.recalc.units += sum.units;
    total.recalc.checked += sum.checked;
    total.recalc.matched += sum.matched;
    for (const e of sum.excluded) add(total.recalc.excluded, e.text, e.count);
    console.log(`${id}：名前が付いた行 ${rows.join("・")}／対象外の単位 ${others}／partial のルール ${stopped.length}/${rev.rules.length}（v23 の定義では ${others > 0 ? rev.rules.length : 0}/${rev.rules.length}）${stopped.length > 0 && stopped.length < rev.rules.length ? `［${stopped.join(" ")}］` : ""}／検算 ${sum.matched}/${sum.checked}/${sum.units}（合った／再計算できた／単位）／指摘 確定 ${sure}・条件つき ${o.findings.length}（うち言い切りの候補 ${o.findings.filter((x) => x.certainty === "確定").length}）／重なりで出さなかった ${o.duplicate + o.judged}`);
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
console.log(`検算（G02）：再計算できた単位 ${frac(total.recalc.checked, total.recalc.units)}、そのうち UKE の点数と合った単位 ${frac(total.recalc.matched, total.recalc.checked)}`);
console.log(`検算の対象外の単位 ${total.recalc.units - total.recalc.checked}（理由ごと。対象外は「合っている」に数えない）：${total.recalc.excluded.size === 0 ? "なし" : ""}`);
for (const [text, n] of total.recalc.excluded) console.log(`  ${text}：${n}`);
console.log("点検ごとの指摘の数（確定・条件つき）と、動いたレセプトの数：");
for (const { id, kind } of GENERIC_CHECKS) {
  const c = total.findings.get(id) ?? { 確定: 0, 条件つき: 0 };
  const not = [...total.notRun].filter(([k]) => k.startsWith(`${id}:`)).map(([k, n]) => `${WHY[k.slice(id.length + 1)]} ${n} 件`);
  console.log(`  ${id}（${kind}）：確定 ${c.確定}・条件つき ${c.条件つき}（うち言い切りの候補 ${total.candidates.get(id) ?? 0}）／動いた ${total.ran.get(id) ?? 0} 件${not.length > 0 ? `／動かさなかった（${not.join("、")}）` : ""}`);
}
console.log(`手書きのルールとの重なりで出さなかった指摘：手書きの指摘と同じ内容 ${total.duplicate} 件、手書きのルールが判定済み ${total.judged} 件`);
console.log(`データで動く点検にかかった時間：レセプト 1 件あたり最大 ${total.ms.max.toFixed(1)} ミリ秒（合計 ${total.ms.sum.toFixed(1)} ミリ秒、行の数は最大 ${total.ms.rows}）`);
