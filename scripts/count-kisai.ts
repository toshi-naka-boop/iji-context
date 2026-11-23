// 設計 v36 の新しい点検の件数だけを数える（design.md §17-6 の 6。呼び出し側が手元の請求で数える）。
// 使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/count-kisai.ts <UKE のファイル…>
// 出すのは件数だけ：G07.form（確定）・G07.form_day00・G07.form_future・G07.missing_any（条件区分 03）と、記載が要ることがある項目（条件区分 00）の数。
// 中身（文字データ）・氏名・番号・コードの値は出さない。何も保存しない。手書きのルールとの重なりは、取り込んだレセプトの点検（src/server/app/uke-check.ts）と同じ作り方で通す
// （同梱の施設の設定・事実はどれも不明・出来事なし・カルテ側の記録なし）。診療年月に版がない請求は、手書きのルールを掛けず、比べの版（令和6年度）の世代でデータの点検だけを掛ける
import { readFileSync } from "node:fs";
import facilityJson from "../config/facility.json";
import { evaluate } from "../src/engine";
import { facilityOf, type FacilityJson } from "../src/engine/facility";
import { hasRevision, resolveRevision, SELECTABLE_REVISIONS } from "../src/engine/revisions";
import type { ClaimContext } from "../src/engine/types";
import { evaluateGeneric } from "../src/generic";
import { conditionalOf, kisaiOf } from "../src/generic/g07";
import { mappedLinesOf, overlap } from "../src/generic/overlap";
import type { GenericAboutMore } from "../src/generic/types";
import { mastersDbPath, openMasters, pickSnapshot } from "../src/masters/db";
import { mapClaim, parseUke, withCommentLines } from "../src/uke/uke";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("使い方：RESEMEN_MASTER_DIR=<masters.db のあるフォルダ> npx tsx scripts/count-kisai.ts <UKE のファイル…>");
  process.exit(1);
}
const db = openMasters(mastersDbPath());
if (db === null) {
  console.error("masters.db がありません（RESEMEN_MASTER_DIR を確かめてください）");
  process.exit(1);
}
const facility = facilityOf(facilityJson as FacilityJson);
const unknown = new Proxy({}, { get: () => ({ known: false }) }) as ClaimContext["facts"];

const total = { claims: 0, unreadable: 0, noRevision: 0, noTable: 0, form: 0, formDay00: 0, formFuture: 0, missing03: 0, conditional: 0, hiddenR17: 0, hiddenPresent: 0, formDuplicate: 0 };
for (const file of files) {
  const parsed = parseUke(readFileSync(file));
  for (const claim of parsed.claims) {
    if (claim.unsupported !== undefined) {
      total.unreadable++;
      continue;
    }
    total.claims++;
    const own = hasRevision(claim.yearMonth);
    // 版がない診療年月は、手書きのルールを掛けない（R17 は動かない）。世代は、その診療年月を含む版（比べの版を含む）があればそれ
    const rev = own ? resolveRevision(claim.yearMonth) : SELECTABLE_REVISIONS.find((r) => r.effectiveFrom <= claim.yearMonth && claim.yearMonth <= r.effectiveUntil);
    if (!own) total.noRevision++;
    const mapped = rev && own ? mapClaim(claim, rev) : null;
    const kubun = mapped ? mapped.lines.filter((l) => l.count > 0).map((l) => l.kubun) : [];
    const about: GenericAboutMore = { yearMonth: claim.yearMonth, generation: rev?.generation ?? "", outpatient: true, ...(rev ? { kisai: kisaiOf(rev, kubun) } : {}) };
    if (pickSnapshot(db, "comment_kanren", about.yearMonth, about.generation) === null) total.noTable++;
    const g = evaluateGeneric(claim, db, about);
    let shown = g.findings;
    if (mapped && rev) {
      const ctx: ClaimContext = { claimId: "count", yearMonth: claim.yearMonth, facility, payer: parsed.payer, prefecture: parsed.prefecture, facts: unknown, events: [], recordsKnown: false, lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })), comments: withCommentLines(mapped.comments, claim), commentsKnown: true, partial: mapped.others.length > 0 };
      const o = overlap(evaluate(ctx), rev, false, mappedLinesOf(mapped.lines, mapped.origins), g.findings);
      total.formDuplicate += g.findings.filter((f) => f.messageKey.startsWith("G07.form")).length - o.findings.filter((f) => f.messageKey.startsWith("G07.form")).length;
      shown = o.findings;
    }
    for (const f of shown) {
      if (f.messageKey === "G07.form" && f.certainty === "確定") total.form++;
      if (f.messageKey === "G07.form_day00") total.formDay00++;
      if (f.messageKey === "G07.form_future") total.formFuture++;
      if (f.messageKey === "G07.missing_any" && f.params.joken === "03") total.missing03++;
    }
    const c = g.ran.some((r) => r.check === "G07") ? conditionalOf(claim, db, about) : null;
    if (c) {
      total.conditional += c.items.length;
      total.hiddenR17 += c.hidden.r17;
      total.hiddenPresent += c.hidden.present;
    }
  }
}
console.log(`読んだレセプト ${total.claims} 件（読めない ${total.unreadable} 件・診療年月に版がない ${total.noRevision} 件・その世代のコメント関連テーブルがない ${total.noTable} 件）`);
console.log(`G07.form（確定）${total.form} 件／G07.form_day00 ${total.formDay00} 件／G07.form_future ${total.formFuture} 件（R17 と重なって出さなかった形の指摘 ${total.formDuplicate} 件）`);
console.log(`G07.missing_any（条件区分 03・項番 0237）${total.missing03} 件`);
console.log(`記載が要ることがある項目（条件区分 00）${total.conditional} 件（外した組：R17 が見ている ${total.hiddenR17}・記載がある ${total.hiddenPresent}）`);
if (total.noTable > 0) console.log("その世代のコメント関連テーブルがない請求では、00 と 0237 は数えていません（形の件数だけ）");
db.close();
